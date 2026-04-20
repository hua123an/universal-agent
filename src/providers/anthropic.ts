import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  deleteSession,
  getSessionMessages,
  importSessionToStore,
  query,
  renameSession,
  type PermissionResult,
  type SessionKey,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import {
  buildAnthropicApprovalRequest,
  evaluateApprovalRequest,
  resolveApprovalRequest,
} from '../approvals/policy.js';
import type {
  ProviderUsageEntry,
  ProviderRunRequest,
  ProviderRunResult,
  SessionMetadata,
} from '../types.js';
import { json, truncate } from '../utils/text.js';

interface TimestampedAnthropicMessage extends SessionMessage {
  timestamp?: string;
}

async function resolveClaudeCodeExecutable(cwd: string): Promise<string | undefined> {
  const override = process.env.CLAUDE_CODE_EXECUTABLE;
  if (override) {
    return override;
  }

  const candidates = [
    path.join(cwd, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'),
    path.join(cwd, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

function isAnthropicDirectFallbackCandidate(error: unknown): boolean {
  return Boolean(
    error instanceof Error &&
      (/issue with the selected model/i.test(error.message) ||
        /returned an error result/i.test(error.message) ||
        /upstream/i.test(error.message))
  );
}

async function runAnthropicDirectFallback(
  request: ProviderRunRequest
): Promise<ProviderRunResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
  });
  const response = await client.messages.create(
    {
      max_tokens: 1024,
      messages: [{ content: request.prompt, role: 'user' }],
      model: request.config.anthropicModel,
      system:
        'You are a direct fallback for a coding agent. If the user asked for code changes or tool use, do not claim you made changes. Be explicit that this fallback cannot run tools or edit files.',
    },
    request.signal ? { signal: request.signal } : undefined
  );

  const text = response.content
    .filter((item): item is Extract<(typeof response.content)[number], { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();

  return {
    metadata: {
      lastRunDegraded: true,
      lastRunNotes: 'anthropic_direct_no_tools',
      lastRunProvider: 'anthropic',
    },
    text: `Warning: Direct Anthropic fallback was used without tool access. No files were modified.\n\n${text}`,
    usageEntries: [
      {
        inputTokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens || 0) +
          (response.usage.cache_read_input_tokens || 0),
        lane: 'main-direct',
        outputTokens: response.usage.output_tokens,
        provider: 'anthropic',
        requests: 1,
        totalTokens:
          response.usage.input_tokens +
          (response.usage.cache_creation_input_tokens || 0) +
          (response.usage.cache_read_input_tokens || 0) +
          response.usage.output_tokens,
      },
    ],
  };
}

interface AnthropicQuestionOption {
  description?: string;
  label: string;
}

interface AnthropicQuestion {
  header?: string;
  multiSelect?: boolean;
  multi_select?: boolean;
  options?: AnthropicQuestionOption[];
  question: string;
}

function describeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const summary = truncate(json(input), 1500);
  return `Tool: ${toolName}\nInput:\n${summary}`;
}

function parseQuestionAnswer(
  response: string,
  options: AnthropicQuestionOption[]
): string {
  const indices = response
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < options.length);

  if (indices.length === 0) {
    return response;
  }

  return indices.map((index) => options[index]?.label).filter(Boolean).join(', ');
}

async function handleAskUserQuestion(
  input: Record<string, unknown>,
  request: ProviderRunRequest
): Promise<PermissionResult> {
  const questions = Array.isArray(input.questions)
    ? (input.questions as AnthropicQuestion[])
    : [];

  if (request.approvalMode === 'auto') {
    return {
      behavior: 'deny',
      message:
        'No interactive user input is available. Make a conservative, reasonable assumption and continue.',
    };
  }

  const answers: Record<string, string> = {};

  for (const question of questions) {
    const options = question.options ?? [];
    request.io.print('');
    request.io.print(`${question.header || 'Question'}: ${question.question}`);
    options.forEach((option, index) => {
      request.io.print(
        `  ${index + 1}. ${option.label}${
          option.description ? ` - ${option.description}` : ''
        }`
      );
    });
    request.io.print(
      question.multiSelect || question.multi_select
        ? '  Enter one or more numbers separated by commas, or type a custom answer.'
        : '  Enter a number, or type a custom answer.'
    );

    const response = (await request.io.ask('Your choice: ')).trim();
    answers[question.question] = parseQuestionAnswer(response, options);
  }

  return {
    behavior: 'allow',
    updatedInput: {
      answers,
      questions,
    },
  };
}

function createAnthropicPermissionHandler(request: ProviderRunRequest) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    context: {
      description?: string;
      displayName?: string;
      title?: string;
    }
  ): Promise<PermissionResult> => {
    const approvalRequest = buildAnthropicApprovalRequest({
      cwd: request.cwd,
      input,
      provider: request.session.provider,
      toolName,
    });

    if (toolName === 'AskUserQuestion') {
      const evaluation = evaluateApprovalRequest(approvalRequest, [
        ...(request.session.approvalRules || []),
        ...(await request.approvalStore.getWorkspaceRules(request.cwd)),
      ]);
      if (evaluation.effect === 'deny') {
        return {
          behavior: 'deny',
          message: 'Question request denied by approval policy.',
        };
      }
      if (evaluation.effect === 'allow') {
        return handleAskUserQuestion(input, {
          ...request,
          approvalMode: 'prompt',
        });
      }
      if (request.approvalMode === 'auto') {
        return {
          behavior: 'deny',
          message:
            'No interactive user input is available. Make a conservative, reasonable assumption and continue.',
        };
      }
      return handleAskUserQuestion(input, request);
    }

    const decision = await resolveApprovalRequest({
      approvalMode: request.approvalMode,
      approvalStore: request.approvalStore,
      io: request.io,
      request: approvalRequest,
      session: request.session,
      store: request.store,
    });

    if (decision === 'deny') {
      return { behavior: 'deny', message: 'Action rejected by approval policy.' };
    }

    return {
      behavior: 'allow',
      updatedInput: input,
    };
  };
}

class AnthropicCaptureStore implements SessionStore {
  readonly entries: SessionStoreEntry[] = [];

  constructor(private readonly targetSessionId: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (key.sessionId !== this.targetSessionId || key.subpath) {
      return;
    }

    this.entries.push(...entries);
  }

  async load(): Promise<SessionStoreEntry[] | null> {
    return null;
  }
}

async function loadAnthropicRawEntries(session: SessionMetadata): Promise<SessionStoreEntry[]> {
  if (!session.anthropicSessionId) {
    return [];
  }

  const store = new AnthropicCaptureStore(session.anthropicSessionId);
  await importSessionToStore(session.anthropicSessionId, store, {
    batchSize: 500,
    dir: session.cwd,
    includeSubagents: false,
  });
  return store.entries;
}

function attachAnthropicTimestamps(
  messages: SessionMessage[],
  rawEntries: SessionStoreEntry[]
): TimestampedAnthropicMessage[] {
  const timestamps = new Map(
    rawEntries
      .filter((entry) => typeof entry.uuid === 'string' && typeof entry.timestamp === 'string')
      .map((entry) => [entry.uuid as string, entry.timestamp as string])
  );

  return messages.map((message) => ({
    ...message,
    timestamp: timestamps.get(message.uuid),
  }));
}

function extractAnthropicTextDelta(event: BetaRawMessageStreamEvent): string {
  if (event.type !== 'content_block_delta') {
    return '';
  }

  return event.delta.type === 'text_delta' ? event.delta.text : '';
}

export async function deleteAnthropicSessionIfPresent(
  session: SessionMetadata
): Promise<void> {
  if (!session.anthropicSessionId) {
    return;
  }

  await deleteSession(session.anthropicSessionId, { dir: session.cwd });
}

export async function exportAnthropicSessionIfPresent(
  session: SessionMetadata
): Promise<TimestampedAnthropicMessage[] | null> {
  if (!session.anthropicSessionId) {
    return null;
  }

  const [messages, rawEntries] = await Promise.all([
    getSessionMessages(session.anthropicSessionId, {
      dir: session.cwd,
      includeSystemMessages: true,
    }),
    loadAnthropicRawEntries(session),
  ]);

  return attachAnthropicTimestamps(messages, rawEntries);
}

export async function renameAnthropicSessionIfPresent(
  session: SessionMetadata,
  title: string
): Promise<void> {
  if (!session.anthropicSessionId) {
    return;
  }

  await renameSession(session.anthropicSessionId, title, { dir: session.cwd });
}

export async function runAnthropicCodingAgent(
  request: ProviderRunRequest
): Promise<ProviderRunResult> {
  const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutable(request.cwd);
  let finalText = '';
  let sessionId = request.session.anthropicSessionId;
  let streamed = false;
  let usageEntries: ProviderUsageEntry[] | undefined;
  let needsAssistantPrefix = true;
  const announcedTools = new Set<string>();
  const abortController = new AbortController();

  if (request.signal) {
    if (request.signal.aborted) {
      abortController.abort(request.signal.reason);
    } else {
      request.signal.addEventListener(
        'abort',
        () => abortController.abort(request.signal?.reason),
        { once: true }
      );
    }
  }

  try {
    const run = query({
      options: {
        abortController,
        canUseTool: createAnthropicPermissionHandler(request),
        cwd: request.cwd,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: 'universal-agent/1.0.0',
        },
        includePartialMessages: request.streamOutput,
        maxTurns: request.maxTurns,
        model: request.config.anthropicModel,
        pathToClaudeCodeExecutable,
        resume: request.session.anthropicSessionId,
        settingSources: ['user', 'project', 'local'],
        tools: {
          preset: 'claude_code',
          type: 'preset',
        },
      },
      prompt: request.prompt,
    });

    for await (const message of run) {
      if ('session_id' in message) {
        sessionId = message.session_id;
      }

      if (request.streamOutput && message.type === 'tool_progress') {
        if (!announcedTools.has(message.tool_use_id)) {
          request.io.printTag(
            'tool',
            `${message.tool_name} running`,
            'tool'
          );
          announcedTools.add(message.tool_use_id);
          needsAssistantPrefix = true;
        }
      }

      if (request.streamOutput && message.type === 'tool_use_summary') {
        request.io.printTag('tool', message.summary, 'tool');
        needsAssistantPrefix = true;
      }

      if (request.streamOutput && message.type === 'stream_event') {
        const delta = extractAnthropicTextDelta(message.event);
        if (delta) {
          if (needsAssistantPrefix) {
            request.io.write(request.io.prefix('assistant', 'assistant'));
            needsAssistantPrefix = false;
          }
          request.io.write(delta);
          streamed = true;
        }
      }

      if (message.type === 'result' && message.subtype === 'success') {
        finalText = message.result;
        sessionId = message.session_id;
        usageEntries = [
          {
            costUSD: message.total_cost_usd,
            inputTokens:
              message.usage.input_tokens +
              message.usage.cache_creation_input_tokens +
              message.usage.cache_read_input_tokens,
            lane: 'main',
            outputTokens: message.usage.output_tokens,
            provider: 'anthropic',
            requests: Array.isArray(message.usage.iterations)
              ? message.usage.iterations.length || 1
              : 1,
            totalTokens:
              message.usage.input_tokens +
              message.usage.cache_creation_input_tokens +
              message.usage.cache_read_input_tokens +
              message.usage.output_tokens,
            turns: message.num_turns,
          },
        ];
      }
    }
  } catch (error) {
    if (!isAnthropicDirectFallbackCandidate(error)) {
      throw error;
    }

    request.io.warn(
      'Claude Code tool mode failed; retrying with direct Anthropic fallback without tools.'
    );
    return runAnthropicDirectFallback(request);
  }

  if (request.signal?.aborted || abortController.signal.aborted) {
    throw new Error('Run cancelled by user.');
  }

  if (!finalText) {
    throw new Error('Anthropic run completed without a final result.');
  }

  return {
    metadata: {
      anthropicSessionId: sessionId,
      lastRunDegraded: false,
      lastRunNotes: undefined,
      lastRunProvider: 'anthropic',
    },
    streamed,
    text: finalText,
    usageEntries,
  };
}
