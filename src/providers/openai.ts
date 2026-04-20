import {
  Agent,
  MCPServerSSE,
  MCPServerStdio,
  MCPServerStreamableHttp,
  Runner,
  applyPatchTool,
  connectMcpServers,
  createMCPToolStaticFilter,
  shellTool,
  tool,
  type MCPServer,
  type RunStreamEvent,
  type RunToolApprovalItem,
} from '@openai/agents';
import { OpenAIProvider } from '@openai/agents-openai';
import { z } from 'zod';
import { runAnthropicCodingAgent } from './anthropic.js';
import {
  buildOpenAIApplyPatchApprovalRequest,
  buildOpenAIShellApprovalRequest,
  evaluateApprovalRequest,
  resolveApprovalRequest,
} from '../approvals/policy.js';
import type {
  HybridPlan,
  HybridReview,
  ProviderUsageEntry,
  ProviderRunRequest,
  ProviderRunResult,
} from '../types.js';
import { JsonFileSession } from '../sessions/file-session.js';
import { WorkspaceEditor } from '../tools/openai-editor.js';
import { WorkspaceShell } from '../tools/openai-shell.js';
import { Workspace } from '../tools/workspace.js';
import { loadClaudeProjectMcpServers } from '../utils/claude-discovery.js';
import { json, truncate } from '../utils/text.js';

const plannerSchema = z.object({
  executionPrompt: z
    .string()
    .min(1)
    .describe('A concise execution brief tailored for a coding agent.'),
  focus: z.array(z.string()).min(1).max(8),
  risks: z.array(z.string()).max(6),
  summary: z.string().min(1),
});

const reviewSchema = z.object({
  concerns: z.array(z.string()).max(8),
  nextSteps: z.array(z.string()).max(6),
  summary: z.string().min(1),
  verdict: z.enum(['ok', 'caution']),
});

function formatMatches(title: string, items: string[]): string {
  if (items.length === 0) {
    return `${title}: [no matches]`;
  }
  return `${title}:\n${items.join('\n')}`;
}

function formatApprovalItem(item: RunToolApprovalItem): string {
  const raw = item.rawItem;

  if (raw.type === 'shell_call') {
    return `Tool: shell\nCommands:\n${raw.action.commands.join('\n')}`;
  }

  if (raw.type === 'apply_patch_call') {
    const operation = raw.operation;
    return `Tool: apply_patch\nOperation: ${operation.type}\nPath: ${operation.path}`;
  }

  return `Tool: ${item.name || 'unknown'}\nInput:\n${truncate(item.arguments || '', 1500)}`;
}

function formatToolCall(rawItem: Record<string, unknown>): string {
  if (rawItem.type === 'shell_call') {
    const action = rawItem.action as { commands?: string[] } | undefined;
    return `shell: ${(action?.commands || []).join(' && ')}`;
  }

  if (rawItem.type === 'apply_patch_call') {
    const operation = rawItem.operation as { path?: string; type?: string } | undefined;
    return `apply_patch: ${operation?.type || 'edit'} ${operation?.path || ''}`.trim();
  }

  if (rawItem.type === 'function_call') {
    return `function: ${String(rawItem.name || 'unknown')}`;
  }

  if (rawItem.type === 'tool_search_call') {
    return 'tool_search';
  }

  return String(rawItem.type || 'tool');
}

function formatToolOutput(item: Record<string, unknown>, output: unknown): string {
  const rawItem = item.rawItem as Record<string, unknown> | undefined;
  if (!rawItem) {
    return truncate(json(output), 200);
  }

  if (rawItem.type === 'shell_call_output') {
    const chunks = Array.isArray(rawItem.output)
      ? (rawItem.output as Array<{
          outcome?: { exitCode?: number | null; type?: string };
          stderr?: string;
          stdout?: string;
        }>)
      : [];
    const summary = chunks
      .map((chunk) => {
        if (chunk.outcome?.type === 'timeout') {
          return 'timeout';
        }
        return `exit=${chunk.outcome?.exitCode ?? 'null'}`;
      })
      .join(', ');
    return `shell output (${summary || 'no output'})`;
  }

  if (rawItem.type === 'apply_patch_call_output') {
    return String(rawItem.output || 'apply_patch completed');
  }

  return truncate(typeof output === 'string' ? output : json(output), 200);
}

function printStreamStatus(request: ProviderRunRequest, message: string): void {
  request.io.printTag('tool', message, 'tool');
}

function writeStreamEvent(
  request: ProviderRunRequest,
  event: RunStreamEvent,
  state: { needsAssistantPrefix: boolean }
): boolean {
  if (event.type === 'run_item_stream_event') {
    const item = event.item as unknown as {
      output?: unknown;
      rawItem?: Record<string, unknown>;
    };

    if (event.name === 'tool_called' && item.rawItem) {
      printStreamStatus(request, formatToolCall(item.rawItem));
      state.needsAssistantPrefix = true;
      return false;
    }

    if (event.name === 'tool_output') {
      printStreamStatus(request, formatToolOutput(item, item.output));
      state.needsAssistantPrefix = true;
      return false;
    }

    if (event.name === 'tool_approval_requested' && item.rawItem) {
      printStreamStatus(request, `approval required for ${formatToolCall(item.rawItem)}`);
      state.needsAssistantPrefix = true;
      return false;
    }
  }

  if (event.type !== 'raw_model_stream_event') {
    return false;
  }

  if (event.data.type !== 'output_text_delta') {
    return false;
  }

  if (state.needsAssistantPrefix) {
    request.io.write(request.io.prefix('assistant', 'assistant'));
    state.needsAssistantPrefix = false;
  }

  request.io.write(event.data.delta);
  return event.data.delta.length > 0;
}

function createReadOnlyTools(workspace: Workspace) {
  return [
    tool({
      description:
        'Read a UTF-8 text file inside the workspace. Supports line ranges for large files.',
      execute: async ({ limit, offset, path }) =>
        workspace.readFileRange(path, offset, limit),
      name: 'read_file',
      parameters: z.object({
        limit: z.number().int().min(1).max(400).default(200),
        offset: z.number().int().min(1).default(1),
        path: z.string().describe('Path relative to the workspace root.'),
      }),
    }),
    tool({
      description:
        'List files in the workspace using a ripgrep glob pattern such as src/**/*.ts.',
      execute: async ({ limit, pattern }) =>
        formatMatches('Files', await workspace.globFiles(pattern, limit)),
      name: 'glob_files',
      parameters: z.object({
        limit: z.number().int().min(1).max(500).default(200),
        pattern: z.string().default('**/*'),
      }),
    }),
    tool({
      description:
        'Search workspace file contents with a regular expression. Optionally narrow with a glob include pattern.',
      execute: async ({ include, limit, pattern }) =>
        formatMatches(
          'Matches',
          await workspace.grepFiles(pattern, include, limit)
        ),
      name: 'grep_files',
      parameters: z.object({
        include: z.string().default('*'),
        limit: z.number().int().min(1).max(500).default(200),
        pattern: z.string().describe('Regular expression to search for.'),
      }),
    }),
    tool({
      description:
        'List a sample of files in the workspace root so the agent can orient itself quickly.',
      execute: async ({ limit }) =>
        formatMatches('Workspace', await workspace.listWorkspace(limit)),
      name: 'describe_workspace',
      parameters: z.object({
        limit: z.number().int().min(1).max(300).default(120),
      }),
    }),
  ];
}

function createWriteTools(request: ProviderRunRequest) {
  const shellNeedsApproval = async (_context: unknown, action: Parameters<typeof buildOpenAIShellApprovalRequest>[0]['action']) => {
    const approvalRequest = buildOpenAIShellApprovalRequest({
      action,
      cwd: request.cwd,
      provider: request.session.provider,
    });
    const evaluation = evaluateApprovalRequest(approvalRequest, [
      ...(request.session.approvalRules || []),
      ...(await request.approvalStore.getWorkspaceRules(request.cwd)),
    ]);
    return evaluation.effect === 'deny' || (evaluation.effect === 'prompt' && request.approvalMode === 'prompt');
  };

  const patchNeedsApproval = async (_context: unknown, operation: Parameters<typeof buildOpenAIApplyPatchApprovalRequest>[0]['operation']) => {
    const approvalRequest = buildOpenAIApplyPatchApprovalRequest({
      cwd: request.cwd,
      operation,
      provider: request.session.provider,
    });
    const evaluation = evaluateApprovalRequest(approvalRequest, [
      ...(request.session.approvalRules || []),
      ...(await request.approvalStore.getWorkspaceRules(request.cwd)),
    ]);
    return evaluation.effect === 'deny' || (evaluation.effect === 'prompt' && request.approvalMode === 'prompt');
  };

  const onApproval = async (_context: unknown, item: RunToolApprovalItem) => {
    let approvalRequest;
    if (item.rawItem.type === 'shell_call') {
      approvalRequest = buildOpenAIShellApprovalRequest({
        action: item.rawItem.action,
        cwd: request.cwd,
        provider: request.session.provider,
      });
    } else if (item.rawItem.type === 'apply_patch_call') {
      approvalRequest = buildOpenAIApplyPatchApprovalRequest({
        cwd: request.cwd,
        operation: item.rawItem.operation,
        provider: request.session.provider,
      });
    } else {
      return { approve: false, reason: 'Unsupported approval item.' };
    }

    request.io.print('');
    request.io.printTag('approval', 'OpenAI tool approval requested', 'warning');
    request.io.print(formatApprovalItem(item));

    const decision = await resolveApprovalRequest({
      approvalMode: request.approvalMode,
      approvalStore: request.approvalStore,
      io: request.io,
      request: approvalRequest,
      session: request.session,
      store: request.store,
    });

    return decision === 'allow'
      ? { approve: true }
      : { approve: false, reason: 'Action rejected by approval policy.' };
  };

  return [
    shellTool({
      needsApproval: shellNeedsApproval,
      onApproval,
      shell: new WorkspaceShell(request.cwd),
    }),
    applyPatchTool({
      editor: new WorkspaceEditor(request.cwd),
      needsApproval: patchNeedsApproval,
      onApproval,
    }),
  ];
}

function createSession(request: ProviderRunRequest, lane: string): JsonFileSession {
  return new JsonFileSession(
    request.store.getOpenAISessionPath(request.session.id, lane),
    request.store.getOpenAISessionId(request.session.id, lane)
  );
}

function createRunner(modelProvider?: OpenAIProvider): Runner {
  process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
  return new Runner({
    modelProvider,
    tracingDisabled: true,
    workflowName: 'Universal Agent',
  });
}

function createOpenAIModelProvider(useResponses: boolean): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    useResponses,
  });
}

function isOpenAICompatFallbackCandidate(error: unknown): boolean {
  return Boolean(
    error instanceof Error &&
      (/Upstream request failed/i.test(error.message) ||
        /invalid api key/i.test(error.message) ||
        /gpt-5\.1/i.test(error.message) ||
        /502/i.test(error.message))
  );
}

function canDelegateToAnthropic(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL);
}

function ensureOutput<T>(output: T | undefined, label: string): T {
  if (output === undefined) {
    throw new Error(`${label} returned no final output.`);
  }
  return output;
}

async function openProjectMcpServers(request: ProviderRunRequest) {
  const loaded = await loadClaudeProjectMcpServers(request.cwd);
  loaded.warnings.forEach((warning) => request.io.warn(warning));

  const servers: MCPServer[] = [];
  for (const [name, entry] of loaded.servers.entries()) {
    const toolFilter = createMCPToolStaticFilter({
      allowed: entry.config.toolFilter?.allowed,
      blocked: entry.config.toolFilter?.blocked,
    });

    if (entry.config.type === 'stdio') {
      servers.push(
        new MCPServerStdio({
          args: entry.config.args,
          command: entry.config.command,
          cwd: request.cwd,
          env: Object.fromEntries(
            Object.entries({ ...process.env, ...(entry.config.env || {}) }).filter(
              (pair): pair is [string, string] => typeof pair[1] === 'string'
            )
          ),
          name,
          toolFilter,
        })
      );
      continue;
    }

    if (entry.config.type === 'http') {
      servers.push(
        new MCPServerStreamableHttp({
          name,
          requestInit: entry.config.headers ? { headers: entry.config.headers } : undefined,
          toolFilter,
          url: entry.config.url,
        })
      );
      continue;
    }

    servers.push(
      new MCPServerSSE({
        eventSourceInit: entry.config.headers ? { headers: entry.config.headers } : undefined,
        name,
        requestInit: entry.config.headers ? { headers: entry.config.headers } : undefined,
        toolFilter,
        url: entry.config.url,
      })
    );
  }

  return connectMcpServers(servers, {
    connectInParallel: true,
    dropFailed: true,
    strict: false,
  });
}

async function withProjectMcpServers<T>(
  request: ProviderRunRequest,
  run: (servers: MCPServer[]) => Promise<T>
): Promise<T> {
  const connectedMcpServers = await openProjectMcpServers(request);
  connectedMcpServers.errors.forEach((error, server) => {
    request.io.warn(`Failed to connect MCP server '${server.name || 'unknown'}': ${error.message}`);
  });

  try {
    return await run(connectedMcpServers.active);
  } finally {
    await connectedMcpServers.close();
  }
}

function extractOpenAIUsage(request: ProviderRunRequest, lane: string, usage: {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  totalTokens: number;
}): ProviderUsageEntry[] {
  return [
    {
      inputTokens: usage.inputTokens,
      lane,
      outputTokens: usage.outputTokens,
      provider: 'openai',
      requests: usage.requests,
      totalTokens: usage.totalTokens,
    },
  ];
}

export async function runOpenAICodingAgent(
  request: ProviderRunRequest
): Promise<ProviderRunResult> {
  const workspace = new Workspace(request.cwd);
  return withProjectMcpServers(request, async (mcpServers) => {
    const runWithProvider = async (useResponses: boolean): Promise<ProviderRunResult> => {
      const modelProvider = createOpenAIModelProvider(useResponses);
      const runner = createRunner(modelProvider);
      const tools = useResponses
        ? [...createReadOnlyTools(workspace), ...createWriteTools(request)]
        : createReadOnlyTools(workspace);
      const agent = new Agent({
      instructions: `You are a pragmatic coding agent working in a real repository.

Use read_file, glob_files, grep_files, and describe_workspace to inspect before editing.
Use apply_patch for code edits and shell for commands such as tests or builds.
Keep changes minimal, verify when practical, and finish with a concise summary of what changed and why.`,
        mcpServers,
        model: process.env.OPENAI_COMPAT_MODEL || request.config.openaiModel,
        name: 'Universal OpenAI Coding Agent',
        tools,
      });

      if (request.streamOutput) {
        const result = await runner.run(agent, request.prompt, {
          maxTurns: request.maxTurns,
          session: createSession(request, useResponses ? 'main' : 'main-compat'),
          signal: request.signal,
          stream: true,
        });
        let streamed = false;
        const streamState = { needsAssistantPrefix: true };

        for await (const event of result) {
          streamed = writeStreamEvent(request, event, streamState) || streamed;
        }

        await result.completed;

        return {
          metadata: {
            lastRunDegraded: !useResponses,
            lastRunNotes: useResponses ? undefined : 'openai_chat_compat_mode',
            lastRunProvider: 'openai',
          },
          streamed,
          text:
            typeof result.finalOutput === 'string'
              ? result.finalOutput
              : json(result.finalOutput),
          usageEntries: extractOpenAIUsage(request, 'main', result.runContext.usage),
        };
      }

      const result = await runner.run(agent, request.prompt, {
        maxTurns: request.maxTurns,
        session: createSession(request, useResponses ? 'main' : 'main-compat'),
        signal: request.signal,
      });

      return {
        metadata: {
          lastRunDegraded: !useResponses,
          lastRunNotes: useResponses ? undefined : 'openai_chat_compat_mode',
          lastRunProvider: 'openai',
        },
        text:
          typeof result.finalOutput === 'string'
            ? result.finalOutput
            : json(result.finalOutput),
        usageEntries: extractOpenAIUsage(request, 'main', result.runContext.usage),
      };
    };

    try {
      return await runWithProvider(true);
    } catch (error) {
      if (!isOpenAICompatFallbackCandidate(error)) {
        throw error;
      }
      request.io.warn(
        'OpenAI Responses mode failed; retrying with chat-completions compatibility mode.'
      );
      try {
        return await runWithProvider(false);
      } catch (compatError) {
        if (!isOpenAICompatFallbackCandidate(compatError)) {
          throw compatError;
        }

        if (canDelegateToAnthropic()) {
          request.io.warn(
            'Current OpenAI-compatible gateway is incompatible with OpenAI Agents execution. Delegating this run to Anthropic fallback for this environment.'
          );
          const delegated = await runAnthropicCodingAgent({
            ...request,
            session: {
              ...request.session,
              provider: 'anthropic',
            },
          });
          return {
            ...delegated,
            metadata: {
              ...delegated.metadata,
              lastRunDegraded: true,
              lastRunNotes: 'openai_gateway_delegated_to_anthropic',
              lastRunProvider: 'anthropic',
            },
          };
        }

        throw new Error(
          'Current OpenAI-compatible gateway is incompatible with OpenAI Agents execution in both Responses and Chat Completions modes. Try a different OpenAI route or use Anthropic mode in this environment.'
        );
      }
    }
  });
}

export async function runOpenAIPlanner(
  request: ProviderRunRequest
): Promise<{ plan: HybridPlan; usageEntries: ProviderUsageEntry[] }> {
  const workspace = new Workspace(request.cwd);
  return withProjectMcpServers(request, async (mcpServers) => {
    const runWithProvider = async (useResponses: boolean) => {
      const runner = createRunner(createOpenAIModelProvider(useResponses));
      const agent = new Agent({
      instructions: `You are a planning specialist preparing execution briefs for a coding agent.

Inspect the workspace with the read-only tools. Then return a brief that tells an execution agent what to change, which files or areas matter most, and what risks to watch.
Do not pretend that you made edits.`,
        mcpServers,
        model: process.env.OPENAI_COMPAT_MODEL || request.config.openaiModel,
        name: 'Hybrid Planner',
        outputType: plannerSchema,
        tools: createReadOnlyTools(workspace),
      });

      const result = await runner.run(agent, request.prompt, {
        maxTurns: Math.min(request.maxTurns, 10),
        session: createSession(request, useResponses ? 'planner' : 'planner-compat'),
        signal: request.signal,
      });

      return {
        plan: ensureOutput(result.finalOutput, 'Hybrid planner') as HybridPlan,
        usageEntries: extractOpenAIUsage(request, 'planner', result.runContext.usage),
      };
    };

    try {
      return await runWithProvider(true);
    } catch (error) {
      if (!isOpenAICompatFallbackCandidate(error)) {
        throw error;
      }
      request.io.warn(
        'OpenAI planner Responses mode failed; retrying with chat-completions compatibility mode.'
      );
      return runWithProvider(false);
    }
  });
}

export async function runOpenAIReviewer(
  request: ProviderRunRequest,
  reviewPrompt: string
): Promise<{ review: HybridReview; usageEntries: ProviderUsageEntry[] }> {
  const workspace = new Workspace(request.cwd);
  return withProjectMcpServers(request, async (mcpServers) => {
    const runWithProvider = async (useResponses: boolean) => {
      const runner = createRunner(createOpenAIModelProvider(useResponses));
      const agent = new Agent({
      instructions: `You are a skeptical code reviewer.

Inspect the current workspace state using read-only tools. Focus on correctness risks, behavioral regressions, and obvious gaps between the task and the implementation summary you were given.
Keep the review concrete and concise.`,
        mcpServers,
        model: process.env.OPENAI_COMPAT_MODEL || request.config.openaiModel,
        name: 'Hybrid Reviewer',
        outputType: reviewSchema,
        tools: createReadOnlyTools(workspace),
      });

      const result = await runner.run(agent, reviewPrompt, {
        maxTurns: Math.min(request.maxTurns, 8),
        session: createSession(request, useResponses ? 'reviewer' : 'reviewer-compat'),
        signal: request.signal,
      });

      return {
        review: ensureOutput(result.finalOutput, 'Hybrid reviewer') as HybridReview,
        usageEntries: extractOpenAIUsage(request, 'reviewer', result.runContext.usage),
      };
    };

    try {
      return await runWithProvider(true);
    } catch (error) {
      if (!isOpenAICompatFallbackCandidate(error)) {
        throw error;
      }
      request.io.warn(
        'OpenAI reviewer Responses mode failed; retrying with chat-completions compatibility mode.'
      );
      return runWithProvider(false);
    }
  });
}
