#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ApprovalStore } from './approvals/store.js';
import {
  loadAppConfig,
  hasAnthropicCredentials,
  hasOpenAICredentials,
  type AppConfig,
} from './config.js';
import {
  deleteAnthropicSessionIfPresent,
  exportAnthropicSessionIfPresent,
  renameAnthropicSessionIfPresent,
  runAnthropicCodingAgent,
} from './providers/anthropic.js';
import { runHybridAgent } from './providers/hybrid.js';
import { runOpenAICodingAgent } from './providers/openai.js';
import { MetadataStore } from './sessions/metadata-store.js';
import type {
  ApprovalMode,
  ProviderMode,
  ProviderUsageEntry,
  SessionMetadata,
  SessionUsageBucket,
  SessionUsageTotals,
} from './types.js';
import { TerminalIO } from './utils/prompt.js';
import { TuiIO } from './utils/tui.js';
import {
  discoverClaudeFeatures,
  loadClaudeProjectMcpServers,
} from './utils/claude-discovery.js';
import { truncate } from './utils/text.js';

type ExportFormat = 'html' | 'json' | 'markdown';
type EntryRole = 'assistant' | 'system' | 'tool' | 'user';
type TranscriptSource = 'all' | 'anthropic' | 'main' | 'planner' | 'reviewer';

const BUILTIN_CHAT_COMMANDS = new Set([
  'help',
  'session',
  'sessions',
  'use',
  'rename',
  'export',
  'history',
  'transcript',
  'commands',
  'skills',
  'mcp',
  'stop',
  'clear',
  'new',
  'delete',
  'exit',
  'quit',
]);

const MANAGEMENT_COMMANDS = new Set([
  'sessions',
  'history',
  'transcript',
  'export',
  'mcp',
  'commands',
  'skills',
]);

interface SessionSnapshot {
  anthropic: {
    error?: string;
    messages?: unknown[];
    sessionId?: string;
  } | null;
  exportedAt: string;
  openai: Record<string, unknown>;
  session: SessionMetadata;
}

interface TranscriptEntry {
  lane: string;
  role: EntryRole;
  sequence: number;
  text: string;
  timestamp?: string;
}

function printHelp(): void {
  console.log(`universal-agent

Usage:
  universal-agent [options] <prompt>
  universal-agent --chat [options] [initial-prompt]
  universal-agent sessions [query]
  universal-agent history [limit]
  universal-agent transcript [source] [limit]
  universal-agent export [--json|--markdown|--html] [path]
  universal-agent mcp

Options:
  --chat                                Start interactive chat mode
  --tui                                 Use the minimal terminal UI in chat mode
  --provider <anthropic|openai|hybrid>  Provider mode for this run
  --approval <auto|prompt>              Approval mode for write/shell actions (default: auto)
  --cwd <path>                          Workspace root to operate in (default: current directory)
  --resume <session-id>                 Resume a prior app session
  --max-turns <number>                  Maximum turns per provider run (default: 20)
  --help                                Show this message

Examples:
  universal-agent --provider hybrid "Audit this repo and clean up the biggest issues"
  universal-agent --provider anthropic --approval prompt "Implement tests for auth.ts"
  universal-agent --chat --tui --provider hybrid
  universal-agent sessions
  universal-agent export --resume <session-id> --markdown
  universal-agent --resume <session-id> "Continue from where you left off"
`);
}

function parseApprovalMode(value: string | undefined): ApprovalMode {
  if (!value || value === 'auto') {
    return 'auto';
  }
  if (value === 'prompt') {
    return 'prompt';
  }
  throw new Error(`Unsupported approval mode: ${value}`);
}

function parseProvider(value: string | undefined): ProviderMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'anthropic' || value === 'openai' || value === 'hybrid') {
    return value;
  }
  throw new Error(`Unsupported provider: ${value}`);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sessionLabel(session: SessionMetadata): string {
  return session.title ? `${session.title} (${session.id})` : session.id;
}

function createEmptyUsageBucket(): SessionUsageBucket {
  return {
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    runs: 0,
    totalTokens: 0,
  };
}

function mergeUsageEntries(
  current: SessionUsageTotals | undefined,
  entries: ProviderUsageEntry[] | undefined
): SessionUsageTotals | undefined {
  if (!entries || entries.length === 0) {
    return current;
  }

  const next: SessionUsageTotals = current
    ? {
        ...current,
        byProvider: {
          anthropic: current.byProvider.anthropic
            ? { ...current.byProvider.anthropic }
            : undefined,
          openai: current.byProvider.openai
            ? { ...current.byProvider.openai }
            : undefined,
        },
      }
    : {
        ...createEmptyUsageBucket(),
        byProvider: {},
      };

  for (const entry of entries) {
    next.costUSD += entry.costUSD || 0;
    next.inputTokens += entry.inputTokens;
    next.outputTokens += entry.outputTokens;
    next.requests += entry.requests;
    next.runs += 1;
    next.totalTokens += entry.totalTokens;

    const bucket = next.byProvider[entry.provider]
      ? { ...next.byProvider[entry.provider]! }
      : createEmptyUsageBucket();
    bucket.costUSD += entry.costUSD || 0;
    bucket.inputTokens += entry.inputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.requests += entry.requests;
    bucket.runs += 1;
    bucket.totalTokens += entry.totalTokens;
    next.byProvider[entry.provider] = bucket;
  }

  return next;
}

function formatUsageSummary(
  totals: SessionUsageTotals | undefined,
  lastEntries?: ProviderUsageEntry[]
): string {
  const parts: string[] = [];

  if (lastEntries && lastEntries.length > 0) {
    const lastInput = lastEntries.reduce((sum, entry) => sum + entry.inputTokens, 0);
    const lastOutput = lastEntries.reduce((sum, entry) => sum + entry.outputTokens, 0);
    const lastCost = lastEntries.reduce((sum, entry) => sum + (entry.costUSD || 0), 0);
    parts.push(`last in=${lastInput} out=${lastOutput}`);
    if (lastCost > 0) {
      parts.push(`last cost=$${lastCost.toFixed(4)}`);
    }
  }

  if (!totals) {
    return parts.length > 0 ? parts.join(' | ') : 'usage: n/a';
  }

  parts.push(`session in=${totals.inputTokens} out=${totals.outputTokens}`);
  if (totals.costUSD > 0) {
    parts.push(`session cost=$${totals.costUSD.toFixed(4)}`);
  }
  return parts.join(' | ');
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof Error && /abort|cancel/i.test(error.message))
  );
}

function updateIoContext(options: {
  approvalMode: ApprovalMode;
  cwd: string;
  io: TerminalIO;
  provider: ProviderMode;
  session: SessionMetadata;
}): void {
  const providerLabel =
    options.session.lastRunProvider && options.session.lastRunProvider !== options.provider
      ? `${options.provider} via ${options.session.lastRunProvider}`
      : options.provider;
  options.io.setSessionContext({
    approvalMode: options.approvalMode,
    cwd: options.cwd,
    provider: providerLabel,
    sessionLabel: sessionLabel(options.session),
  });
  options.io.setUsageSummary(
    formatUsageSummary(options.session.usageTotals, options.session.lastUsageEntries)
  );
}

async function updateSidebarSessions(options: {
  currentSessionId: string;
  cwd: string;
  io: TerminalIO;
  provider: ProviderMode;
  store: MetadataStore;
}): Promise<void> {
  const sessions = await options.store.listRecent({
    cwd: options.cwd,
    limit: 5,
    provider: options.provider,
  });
  options.io.setSidebarItems(
    sessions.map((session, index) => {
      const title = session.title || truncate(session.lastPromptPreview || '[untitled]', 24);
      return `${index + 1}. ${session.id === options.currentSessionId ? '*' : ' '} ${title}`;
    })
  );
}

function isCustomSlashCommand(prompt: string, provider: ProviderMode): boolean {
  if (!prompt.startsWith('/')) {
    return false;
  }

  const command = parseChatCommand(prompt);
  if (!command?.name || BUILTIN_CHAT_COMMANDS.has(command.name)) {
    return false;
  }

  return provider === 'anthropic' || provider === 'hybrid';
}

function sessionMatchesScope(
  session: SessionMetadata,
  options: { cwd: string; provider: ProviderMode }
): boolean {
  return (
    path.resolve(session.cwd) === path.resolve(options.cwd) &&
    session.provider === options.provider
  );
}

function toneForRole(role: EntryRole): 'assistant' | 'muted' | 'tool' | 'user' {
  if (role === 'assistant') {
    return 'assistant';
  }
  if (role === 'user') {
    return 'user';
  }
  if (role === 'tool') {
    return 'tool';
  }
  return 'muted';
}

function parseCommandTokens(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map((token) => {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function extractTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextFragments(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const fragments: string[] = [];

  if (typeof value.text === 'string') {
    fragments.push(value.text);
  }

  if (typeof value.content === 'string') {
    fragments.push(value.content);
  }

  if ('message' in value) {
    fragments.push(...extractTextFragments(value.message));
  }

  if (Array.isArray(value.content)) {
    fragments.push(...value.content.flatMap((item) => extractTextFragments(item)));
  }

  if ('output' in value) {
    fragments.push(...extractTextFragments(value.output));
  }

  if (typeof value.summary === 'string') {
    fragments.push(value.summary);
  }

  return fragments.filter(Boolean);
}

function parseChatCommand(input: string): { args: string; name: string } | null {
  if (!input.startsWith('/')) {
    return null;
  }

  const trimmed = input.slice(1).trim();
  if (!trimmed) {
    return { args: '', name: '' };
  }

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return { args: '', name: trimmed };
  }

  return {
    args: trimmed.slice(firstSpace + 1),
    name: trimmed.slice(0, firstSpace),
  };
}

async function readPrompt(positionals: string[]): Promise<string> {
  const positionalPrompt = positionals.join(' ').trim();
  if (positionalPrompt) {
    return positionalPrompt;
  }

  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }

  return chunks.join('').trim();
}

function assertCredentials(provider: ProviderMode): void {
  if ((provider === 'anthropic' || provider === 'hybrid') && !hasAnthropicCredentials()) {
    throw new Error(
      'Anthropic credentials are missing. Set ANTHROPIC_API_KEY or configure a supported Claude Code provider.'
    );
  }

  if ((provider === 'openai' || provider === 'hybrid') && !hasOpenAICredentials()) {
    throw new Error('OpenAI credentials are missing. Set OPENAI_API_KEY.');
  }
}

async function executeTurn(options: {
  approvalMode: ApprovalMode;
  approvalStore: ApprovalStore;
  config: AppConfig;
  cwd: string;
  io: TerminalIO;
  maxTurns: number;
  prompt: string;
  provider: ProviderMode;
  session: SessionMetadata;
  store: MetadataStore;
  streamOutput: boolean;
}): Promise<SessionMetadata> {
  const controller = new AbortController();
  const onSigint = () => {
    if (!controller.signal.aborted) {
      options.io.warn('Stop requested. Cancelling current run...');
      controller.abort(new Error('Run cancelled by user.'));
    }
  };

  const effectiveProvider =
    options.provider === 'hybrid' && isCustomSlashCommand(options.prompt, options.provider)
      ? 'anthropic'
      : options.provider;

  const request = {
    approvalMode: options.approvalMode,
    approvalStore: options.approvalStore,
    config: options.config,
    cwd: options.cwd,
    io: options.io,
    maxTurns: options.maxTurns,
    prompt: options.prompt,
    session: options.session,
    signal: controller.signal,
    store: options.store,
    streamOutput: options.streamOutput,
  };

  if (effectiveProvider !== options.provider) {
    options.io.printTag(
      'planner',
      'Bypassing hybrid planning for Claude slash command execution.',
      'planner'
    );
  }

  process.on('SIGINT', onSigint);
  options.io.setRunCancellation(onSigint);
  options.io.setStatus('running');

  let result;
  try {
    result =
      effectiveProvider === 'anthropic'
        ? await runAnthropicCodingAgent(request)
        : effectiveProvider === 'openai'
        ? await runOpenAICodingAgent(request)
        : await runHybridAgent(request);
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new Error('Run cancelled by user.');
    }
      throw error;
  } finally {
    process.off('SIGINT', onSigint);
    options.io.setRunCancellation(null);
    options.io.setStatus('idle');
  }

  const nextSession = {
    ...options.session,
    ...result.metadata,
    lastPromptPreview: truncate(options.prompt, 240),
    provider: options.provider,
    lastUsageEntries: result.usageEntries,
    usageTotals: mergeUsageEntries(options.session.usageTotals, result.usageEntries),
  };

  await options.store.save(nextSession);
  options.io.setUsageSummary(
    formatUsageSummary(nextSession.usageTotals, nextSession.lastUsageEntries)
  );

  if (!options.streamOutput) {
    options.io.print('');
    options.io.print(result.text);
    if (result.usageEntries && result.usageEntries.length > 0) {
      options.io.printTag(
        'usage',
        formatUsageSummary(nextSession.usageTotals, result.usageEntries),
        'muted'
      );
    }
    return nextSession;
  }

  if (options.provider === 'hybrid') {
    if (!result.streamed) {
      options.io.print('');
      options.io.print(result.text);
    }
    return nextSession;
  }

  if (result.streamed) {
    if (!result.text.endsWith('\n')) {
      options.io.print('');
    }
    return nextSession;
  }

  options.io.write(options.io.prefix('assistant', 'assistant'));
  options.io.write(result.text);
  if (!result.text.endsWith('\n')) {
    options.io.print('');
  }

  if (result.usageEntries && result.usageEntries.length > 0) {
    options.io.printTag(
      'usage',
      formatUsageSummary(nextSession.usageTotals, result.usageEntries),
      'muted'
    );
  }

  return nextSession;
}

function formatSessionSummary(
  session: SessionMetadata,
  index: number,
  currentSessionId: string
): string[] {
  const title = session.title ? ` - ${session.title}` : '';
  const provider = session.lastRunProvider && session.lastRunProvider !== session.provider
    ? `${session.provider} via ${session.lastRunProvider}`
    : session.provider;
  const degraded = session.lastRunDegraded ? ' [degraded]' : '';
  const notes = session.lastRunNotes ? `   note: ${session.lastRunNotes}` : null;

  return [
    `${index}. ${session.id}${session.id === currentSessionId ? ' [current]' : ''}${title}`,
    `   provider: ${provider}${degraded}`,
    `   updated: ${session.updatedAt}`,
    `   last: ${session.lastPromptPreview || '[no prompt preview]'}`,
    ...(notes ? [notes] : []),
  ];
}

async function printRecentSessions(options: {
  currentSessionId: string;
  cwd: string;
  io: TerminalIO;
  provider: ProviderMode;
  query?: string;
  store: MetadataStore;
}): Promise<SessionMetadata[]> {
  const query = options.query?.trim() || undefined;
  const sessions = await options.store.listRecent({
    cwd: options.cwd,
    limit: 10,
    provider: options.provider,
    query,
  });

  if (sessions.length === 0) {
    options.io.print(
      query
        ? `No sessions matched '${query}' for this workspace and provider.`
        : 'No saved sessions found for this workspace and provider.'
    );
    return sessions;
  }

  options.io.print(
    query ? `Recent sessions matching '${query}':` : 'Recent sessions:'
  );
  sessions.forEach((session, index) => {
    for (const line of formatSessionSummary(
      session,
      index + 1,
      options.currentSessionId
    )) {
      options.io.print(line);
    }
  });

  return sessions;
}

async function resolveSessionReference(options: {
  currentSessionId: string;
  cwd: string;
  io: TerminalIO;
  provider: ProviderMode;
  rawArgs: string;
  store: MetadataStore;
}): Promise<SessionMetadata | null> {
  const query = options.rawArgs.trim();

  if (!query) {
    const sessions = await printRecentSessions({
      currentSessionId: options.currentSessionId,
      cwd: options.cwd,
      io: options.io,
      provider: options.provider,
      store: options.store,
    });

    if (sessions.length === 0) {
      return null;
    }

    const response = (await options.io.ask('Select session number: ')).trim();
    const index = Number.parseInt(response, 10) - 1;
    return sessions[index] ?? null;
  }

  if (/^\d+$/.test(query)) {
    const sessions = await options.store.listRecent({
      cwd: options.cwd,
      limit: 10,
      provider: options.provider,
    });
    const index = Number.parseInt(query, 10) - 1;
    return sessions[index] ?? null;
  }

  const exact = await options.store.load(query);
  if (exact) {
    if (!sessionMatchesScope(exact, { cwd: options.cwd, provider: options.provider })) {
      options.io.warn(
        `Session ${exact.id} belongs to a different workspace or provider.`
      );
      return null;
    }

    return exact;
  }

  const matches = await options.store.listRecent({
    cwd: options.cwd,
    limit: 10,
    provider: options.provider,
    query,
  });

  if (matches.length === 0) {
    return null;
  }

  if (matches.length === 1) {
    return matches[0] ?? null;
  }

  options.io.print(`Multiple sessions matched '${query}':`);
  matches.forEach((session, index) => {
    for (const line of formatSessionSummary(
      session,
      index + 1,
      options.currentSessionId
    )) {
      options.io.print(line);
    }
  });

  const response = (await options.io.ask('Select session number: ')).trim();
  const index = Number.parseInt(response, 10) - 1;
  return matches[index] ?? null;
}

async function buildSessionSnapshot(options: {
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<SessionSnapshot> {
  const openai = await options.store.readOpenAILanes(options.session.id);
  let anthropic: SessionSnapshot['anthropic'] = null;

  if (options.session.anthropicSessionId) {
    try {
      anthropic = {
        messages: (await exportAnthropicSessionIfPresent(options.session)) || [],
        sessionId: options.session.anthropicSessionId,
      };
    } catch (error) {
      anthropic = {
        error: error instanceof Error ? error.message : String(error),
        sessionId: options.session.anthropicSessionId,
      };
    }
  }

  return {
    anthropic,
    exportedAt: new Date().toISOString(),
    openai,
    session: options.session,
  };
}

function collectAnthropicEntries(snapshot: SessionSnapshot): TranscriptEntry[] {
  const messages = snapshot.anthropic?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  messages.forEach((item, index) => {
    if (!isRecord(item) || typeof item.type !== 'string') {
      return;
    }

    const role =
      item.type === 'user' || item.type === 'assistant' || item.type === 'system'
        ? item.type
        : 'system';
    const text = normalizeText(extractTextFragments(item.message).join('\n'));
    if (!text) {
      return;
    }

    entries.push({
      lane: 'anthropic',
      role,
      sequence: index + 1,
      text,
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : undefined,
    });
  });

  return entries;
}

function formatOpenAIToolCall(item: Record<string, unknown>): string {
  if (item.type === 'shell_call' && isRecord(item.action)) {
    const commands = Array.isArray(item.action.commands)
      ? item.action.commands.map(String)
      : [];
    return `shell: ${commands.join(' && ')}`;
  }

  if (item.type === 'apply_patch_call' && isRecord(item.operation)) {
    return `apply_patch: ${String(item.operation.type || 'edit')} ${String(
      item.operation.path || ''
    )}`.trim();
  }

  if (item.type === 'function_call') {
    return `function: ${String(item.name || 'unknown')}`;
  }

  if (item.type === 'tool_search_call') {
    return 'tool_search';
  }

  if (item.type === 'hosted_tool_call') {
    return `hosted_tool: ${String(item.name || 'unknown')}`;
  }

  return String(item.type || 'tool');
}

function formatOpenAIToolOutput(item: Record<string, unknown>): string {
  if (item.type === 'shell_call_output' && Array.isArray(item.output)) {
    const summary = item.output
      .map((chunk) => {
        if (!isRecord(chunk) || !isRecord(chunk.outcome)) {
          return 'shell output';
        }
        if (chunk.outcome.type === 'timeout') {
          return 'timeout';
        }
        return `exit=${String(chunk.outcome.exitCode ?? 'null')}`;
      })
      .join(', ');
    return `shell output (${summary || 'no output'})`;
  }

  if (item.type === 'apply_patch_call_output') {
    return String(item.output || 'apply_patch completed');
  }

  const text = normalizeText(extractTextFragments(item.output).join('\n'));
  return text || String(item.type || 'tool output');
}

function collectOpenAILaneEntries(
  snapshot: SessionSnapshot,
  lane: 'main' | 'planner' | 'reviewer'
): TranscriptEntry[] {
  const laneData = snapshot.openai[lane];
  if (!isRecord(laneData)) {
    return [];
  }

  type StoredLaneEntry = {
    item: Record<string, unknown>;
    recordedAt: string | undefined;
    sequence: number;
  };

  let normalizedEntries: StoredLaneEntry[] = [];
  if (Array.isArray(laneData.entries)) {
    normalizedEntries = laneData.entries
      .map((entry, index) => {
        if (!isRecord(entry) || !('item' in entry) || !isRecord(entry.item)) {
          return null;
        }

        return {
          item: entry.item,
          recordedAt:
            typeof entry.recordedAt === 'string' && entry.recordedAt
              ? entry.recordedAt
              : undefined,
          sequence: typeof entry.sequence === 'number' ? entry.sequence : index + 1,
        };
      })
      .filter((entry) => entry !== null) as StoredLaneEntry[];
  } else if (Array.isArray(laneData.items)) {
    normalizedEntries = laneData.items
      .map((item, index) => {
        if (!isRecord(item)) {
          return null;
        }

        return {
          item,
          recordedAt: undefined,
          sequence: index + 1,
        };
      })
      .filter((entry) => entry !== null) as StoredLaneEntry[];
  }

  const entries: TranscriptEntry[] = [];
  for (const stored of normalizedEntries) {
    const item = stored.item;

    if (
      (item.role === 'user' || item.role === 'assistant' || item.role === 'system') &&
      ('content' in item || 'message' in item)
    ) {
      const role = item.role as EntryRole;
      const text = normalizeText(
        extractTextFragments('content' in item ? item.content : item.message).join('\n')
      );
      if (text) {
        entries.push({
          lane: `openai:${lane}`,
          role,
          sequence: stored.sequence,
          text,
          timestamp: stored.recordedAt,
        });
      }
      continue;
    }

    if (
      item.type === 'function_call' ||
      item.type === 'shell_call' ||
      item.type === 'apply_patch_call' ||
      item.type === 'tool_search_call' ||
      item.type === 'hosted_tool_call'
    ) {
      entries.push({
        lane: `openai:${lane}`,
        role: 'tool',
        sequence: stored.sequence,
        text: formatOpenAIToolCall(item),
        timestamp: stored.recordedAt,
      });
      continue;
    }

    if (
      item.type === 'function_call_result' ||
      item.type === 'shell_call_output' ||
      item.type === 'apply_patch_call_output' ||
      item.type === 'tool_search_output'
    ) {
      entries.push({
        lane: `openai:${lane}`,
        role: 'tool',
        sequence: stored.sequence,
        text: formatOpenAIToolOutput(item),
        timestamp: stored.recordedAt,
      });
      continue;
    }
  }

  return entries;
}

function compareTranscriptEntries(left: TranscriptEntry, right: TranscriptEntry): number {
  if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) {
    return left.timestamp.localeCompare(right.timestamp);
  }

  if (left.timestamp && !right.timestamp) {
    return -1;
  }

  if (!left.timestamp && right.timestamp) {
    return 1;
  }

  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  return left.lane.localeCompare(right.lane);
}

function collectAllEntries(snapshot: SessionSnapshot): TranscriptEntry[] {
  return [
    ...collectAnthropicEntries(snapshot),
    ...collectOpenAILaneEntries(snapshot, 'main'),
    ...collectOpenAILaneEntries(snapshot, 'planner'),
    ...collectOpenAILaneEntries(snapshot, 'reviewer'),
  ].sort(compareTranscriptEntries);
}

function getPrimaryHistoryEntries(
  snapshot: SessionSnapshot,
  provider: ProviderMode
): TranscriptEntry[] {
  const anthropic = collectAnthropicEntries(snapshot);
  if (anthropic.length > 0) {
    return anthropic.sort(compareTranscriptEntries);
  }

  const main = collectOpenAILaneEntries(snapshot, 'main');
  if (main.length > 0) {
    return main.sort(compareTranscriptEntries);
  }

  if (provider === 'hybrid') {
    return collectAllEntries(snapshot);
  }

  return [
    ...collectOpenAILaneEntries(snapshot, 'planner'),
    ...collectOpenAILaneEntries(snapshot, 'reviewer'),
  ].sort(compareTranscriptEntries);
}

function parseExportArgs(rawArgs: string): {
  format: ExportFormat;
  outputPath?: string;
} {
  const tokens = parseCommandTokens(rawArgs);
  let format: ExportFormat = 'json';
  const rest: string[] = [];

  for (const token of tokens) {
    if (token === '--markdown' || token === 'markdown' || token === 'md') {
      format = 'markdown';
      continue;
    }
    if (token === '--html' || token === 'html') {
      format = 'html';
      continue;
    }
    if (token === '--json' || token === 'json') {
      format = 'json';
      continue;
    }
    rest.push(token);
  }

  return {
    format,
    outputPath: rest.length > 0 ? rest.join(' ') : undefined,
  };
}

function parseHistoryLimit(rawArgs: string, fallback: number): number {
  const tokens = parseCommandTokens(rawArgs);
  const numeric = tokens.find((token) => /^\d+$/.test(token));
  return numeric ? Math.max(1, Number.parseInt(numeric, 10)) : fallback;
}

function parseTranscriptArgs(rawArgs: string, provider: ProviderMode): {
  limit: number;
  source: TranscriptSource;
} {
  const tokens = parseCommandTokens(rawArgs);
  let source: TranscriptSource = provider === 'openai' ? 'main' : provider === 'anthropic' ? 'anthropic' : 'all';
  let limit = 40;

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      limit = Math.max(1, Number.parseInt(token, 10));
      continue;
    }

    if (
      token === 'all' ||
      token === 'anthropic' ||
      token === 'main' ||
      token === 'planner' ||
      token === 'reviewer'
    ) {
      source = token;
    }
  }

  return { limit, source };
}

function formatEntryLabel(entry: TranscriptEntry, includeLane: boolean): string {
  const base = includeLane ? `${entry.lane} ${entry.role}` : entry.role;
  return entry.timestamp ? `${entry.timestamp} ${base}` : base;
}

function printEntries(options: {
  entries: TranscriptEntry[];
  includeLane: boolean;
  io: TerminalIO;
  limit: number;
  title: string;
}): void {
  const visible = options.entries.slice(-options.limit);
  if (visible.length === 0) {
    options.io.print(`${options.title}: no entries.`);
    return;
  }

  options.io.print(`${options.title}:`);
  for (const entry of visible) {
    options.io.printTag(
      formatEntryLabel(entry, options.includeLane),
      entry.text,
      toneForRole(entry.role)
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function markdownSection(title: string, entries: TranscriptEntry[]): string {
  if (entries.length === 0) {
    return `## ${title}\n\n_No entries._`;
  }

  const blocks = entries.map((entry) => {
    return `### ${entry.lane} ${entry.role}\n\n\`\`\`text\n${entry.text}\n\`\`\``;
  });

  return `## ${title}\n\n${blocks.join('\n\n')}`;
}

function htmlSection(title: string, entries: TranscriptEntry[]): string {
  if (entries.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p>No entries.</p></section>`;
  }

  const items = entries
    .map((entry) => {
      return `<article class="entry ${escapeHtml(entry.role)}"><h3>${escapeHtml(
        `${entry.lane} ${entry.role}`
      )}</h3><pre>${escapeHtml(entry.text)}</pre></article>`;
    })
    .join('');

  return `<section><h2>${escapeHtml(title)}</h2>${items}</section>`;
}

function renderMarkdownExport(snapshot: SessionSnapshot): string {
  const sections = [
    '# Universal Agent Session Export',
    '',
    '## Session',
    '',
    `- ID: ${snapshot.session.id}`,
    `- Title: ${snapshot.session.title || '[untitled]'}`,
    `- Provider: ${snapshot.session.provider}`,
    `- Workspace: ${snapshot.session.cwd}`,
    `- Created: ${snapshot.session.createdAt}`,
    `- Updated: ${snapshot.session.updatedAt}`,
    `- Exported: ${snapshot.exportedAt}`,
    '',
    markdownSection('Anthropic Transcript', collectAnthropicEntries(snapshot)),
    '',
    markdownSection('OpenAI Main Lane', collectOpenAILaneEntries(snapshot, 'main')),
    '',
    markdownSection('OpenAI Planner Lane', collectOpenAILaneEntries(snapshot, 'planner')),
    '',
    markdownSection('OpenAI Reviewer Lane', collectOpenAILaneEntries(snapshot, 'reviewer')),
  ];

  if (snapshot.anthropic?.error) {
    sections.push('', '## Anthropic Error', '', snapshot.anthropic.error);
  }

  return sections.join('\n');
}

function renderHtmlExport(snapshot: SessionSnapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(snapshot.session.title || snapshot.session.id)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #e5e7eb; background: #0f172a; }
    h1, h2, h3 { color: #f8fafc; }
    section { margin: 2rem 0; padding: 1rem; border: 1px solid #334155; border-radius: 12px; background: #111827; }
    article { margin: 1rem 0; padding: 0.75rem; border-left: 4px solid #64748b; background: #0b1220; }
    article.user { border-color: #38bdf8; }
    article.assistant { border-color: #818cf8; }
    article.tool { border-color: #f472b6; }
    article.system { border-color: #94a3b8; }
    pre { white-space: pre-wrap; word-break: break-word; background: #020617; padding: 0.75rem; border-radius: 8px; }
    ul { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Universal Agent Session Export</h1>
  <section>
    <h2>Session</h2>
    <ul>
      <li>ID: ${escapeHtml(snapshot.session.id)}</li>
      <li>Title: ${escapeHtml(snapshot.session.title || '[untitled]')}</li>
      <li>Provider: ${escapeHtml(snapshot.session.provider)}</li>
      <li>Workspace: ${escapeHtml(snapshot.session.cwd)}</li>
      <li>Created: ${escapeHtml(snapshot.session.createdAt)}</li>
      <li>Updated: ${escapeHtml(snapshot.session.updatedAt)}</li>
      <li>Exported: ${escapeHtml(snapshot.exportedAt)}</li>
    </ul>
  </section>
  ${htmlSection('Anthropic Transcript', collectAnthropicEntries(snapshot))}
  ${htmlSection('OpenAI Main Lane', collectOpenAILaneEntries(snapshot, 'main'))}
  ${htmlSection('OpenAI Planner Lane', collectOpenAILaneEntries(snapshot, 'planner'))}
  ${htmlSection('OpenAI Reviewer Lane', collectOpenAILaneEntries(snapshot, 'reviewer'))}
  ${snapshot.anthropic?.error ? `<section><h2>Anthropic Error</h2><pre>${escapeHtml(snapshot.anthropic.error)}</pre></section>` : ''}
</body>
</html>`;
}

async function deleteSessionEverywhere(options: {
  io: TerminalIO;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<void> {
  try {
    await deleteAnthropicSessionIfPresent(options.session);
  } catch (error) {
    options.io.warn(
      `Failed to delete Anthropic transcript for ${options.session.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  await options.store.delete(options.session);
}

async function clearSessionHistoryEverywhere(options: {
  io: TerminalIO;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<SessionMetadata> {
  try {
    await deleteAnthropicSessionIfPresent(options.session);
  } catch (error) {
    options.io.warn(
      `Failed to clear Anthropic transcript for ${options.session.id}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return options.store.clearHistory(options.session);
}

async function exportSessionSnapshot(options: {
  cwd: string;
  outputArgs: string;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<string> {
  const parsed = parseExportArgs(options.outputArgs);
  const extension =
    parsed.format === 'html' ? 'html' : parsed.format === 'markdown' ? 'md' : 'json';
  const filePath = path.resolve(
    options.cwd,
    parsed.outputPath?.trim() || `universal-agent-session-${options.session.id}.${extension}`
  );
  const snapshot = await buildSessionSnapshot({
    session: options.session,
    store: options.store,
  });

  const content =
    parsed.format === 'json'
      ? JSON.stringify(snapshot, null, 2)
      : parsed.format === 'markdown'
      ? renderMarkdownExport(snapshot)
      : renderHtmlExport(snapshot);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return filePath;
}

async function renameCurrentSession(options: {
  io: TerminalIO;
  rawArgs: string;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<SessionMetadata> {
  const title = options.rawArgs.trim() || (await options.io.ask('Session title: ')).trim();
  if (!title) {
    options.io.warn('Session title cannot be empty.');
    return options.session;
  }

  let next = await options.store.rename(options.session, title);

  try {
    await renameAnthropicSessionIfPresent(next, title);
  } catch (error) {
    options.io.warn(
      `Renamed local session, but failed to rename Anthropic transcript: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  next = await options.store.loadOrCreate({
    cwd: next.cwd,
    provider: next.provider,
    resumeId: next.id,
  });
  options.io.success(`Renamed session to '${title}'.`);
  return next;
}

async function deleteSelectedSession(options: {
  currentSession: SessionMetadata;
  cwd: string;
  io: TerminalIO;
  provider: ProviderMode;
  rawArgs: string;
  store: MetadataStore;
}): Promise<SessionMetadata> {
  const target = options.rawArgs.trim()
    ? await resolveSessionReference({
        currentSessionId: options.currentSession.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        rawArgs: options.rawArgs,
        store: options.store,
      })
    : options.currentSession;

  if (!target) {
    options.io.warn(
      options.rawArgs.trim()
        ? `No session matched '${options.rawArgs.trim()}'.`
        : 'No session selected.'
    );
    return options.currentSession;
  }

  const confirmed = await options.io.confirm(`Delete session ${sessionLabel(target)}?`);
  if (!confirmed) {
    return options.currentSession;
  }

  await deleteSessionEverywhere({
    io: options.io,
    session: target,
    store: options.store,
  });

  options.io.success(`Deleted session: ${sessionLabel(target)}`);

  if (target.id !== options.currentSession.id) {
    return options.currentSession;
  }

  const fresh = await options.store.create({
    cwd: options.cwd,
    provider: options.provider,
  });
  options.io.success(`Started replacement session: ${fresh.id}`);
  return fresh;
}

async function showHistory(options: {
  io: TerminalIO;
  provider: ProviderMode;
  rawArgs: string;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<void> {
  const limit = parseHistoryLimit(options.rawArgs, 12);
  const snapshot = await buildSessionSnapshot({
    session: options.session,
    store: options.store,
  });
  const entries = getPrimaryHistoryEntries(snapshot, options.provider);

  printEntries({
    entries,
    includeLane: options.provider === 'hybrid',
    io: options.io,
    limit,
    title: `History (last ${limit})`,
  });
}

async function showTranscript(options: {
  io: TerminalIO;
  provider: ProviderMode;
  rawArgs: string;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<void> {
  const parsed = parseTranscriptArgs(options.rawArgs, options.provider);
  const snapshot = await buildSessionSnapshot({
    session: options.session,
    store: options.store,
  });

  let entries: TranscriptEntry[] = [];
  if (parsed.source === 'anthropic') {
    entries = collectAnthropicEntries(snapshot);
  } else if (parsed.source === 'main') {
    entries = collectOpenAILaneEntries(snapshot, 'main');
  } else if (parsed.source === 'planner') {
    entries = collectOpenAILaneEntries(snapshot, 'planner');
  } else if (parsed.source === 'reviewer') {
    entries = collectOpenAILaneEntries(snapshot, 'reviewer');
  } else {
    entries = collectAllEntries(snapshot);
  }

  printEntries({
    entries,
    includeLane: parsed.source === 'all',
    io: options.io,
    limit: parsed.limit,
    title: `Transcript (${parsed.source}, last ${parsed.limit})`,
  });

  if (parsed.source === 'anthropic' && snapshot.anthropic?.error) {
    options.io.warn(`Anthropic transcript error: ${snapshot.anthropic.error}`);
  }
}

async function showClaudeDiscovery(options: {
  cwd: string;
  io: TerminalIO;
  mode: 'commands' | 'mcp' | 'skills';
}): Promise<void> {
  if (options.mode === 'commands') {
    const discovery = await discoverClaudeFeatures(options.cwd);
    options.io.print('Claude commands:');
    options.io.print(`  CLAUDE.md: ${discovery.claudeMd ? 'present' : 'missing'}`);
    options.io.print(
      `  commands: ${discovery.commands.length > 0 ? discovery.commands.join(', ') : '[none]'}`
    );
    return;
  }

  if (options.mode === 'skills') {
    const discovery = await discoverClaudeFeatures(options.cwd);
    options.io.print('Claude skills:');
    options.io.print(
      `  skills: ${discovery.skills.length > 0 ? discovery.skills.join(', ') : '[none]'}`
    );
    return;
  }

  const mcp = await loadClaudeProjectMcpServers(options.cwd);
  options.io.print('Claude MCP:');
  options.io.print(`  config files: ${mcp.files.length > 0 ? mcp.files.join(', ') : '[none]'}`);
  if (mcp.servers.size === 0) {
    options.io.print('  servers: [none]');
  } else {
    for (const [name, entry] of mcp.servers.entries()) {
      options.io.print(
        `  - ${name}: type=${entry.config.type} source=${entry.source}`
      );
      if (entry.config.toolFilter?.allowed?.length) {
        options.io.print(`      allow: ${entry.config.toolFilter.allowed.join(', ')}`);
      }
      if (entry.config.toolFilter?.blocked?.length) {
        options.io.print(`      block: ${entry.config.toolFilter.blocked.join(', ')}`);
      }
    }
  }
  if (mcp.warnings.length > 0) {
    options.io.print('  warnings:');
    mcp.warnings.forEach((warning) => options.io.print(`    - ${warning}`));
  }
}

async function resolveCommandSession(options: {
  cwd: string;
  provider?: ProviderMode;
  resumeId?: string;
  store: MetadataStore;
}): Promise<SessionMetadata> {
  if (options.resumeId) {
    return options.store.loadOrCreate({
      cwd: options.cwd,
      provider: options.provider,
      resumeId: options.resumeId,
    });
  }

  const sessions = await options.store.listRecent({
    cwd: options.cwd,
    limit: 1,
    provider: options.provider,
  });
  const session = sessions[0];
  if (!session) {
    throw new Error('No saved sessions found for this workspace. Use --resume or start a chat first.');
  }

  return session;
}

async function runManagementCommand(options: {
  command: string;
  cwd: string;
  io: TerminalIO;
  provider?: ProviderMode;
  rawArgs: string;
  resumeId?: string;
  store: MetadataStore;
}): Promise<void> {
  if (options.command === 'sessions') {
    const sessions = await options.store.listRecent({
      cwd: options.cwd,
      limit: 20,
      provider: options.provider,
      query: options.rawArgs.trim() || undefined,
    });
    if (sessions.length === 0) {
      options.io.print('No saved sessions found.');
      return;
    }

    sessions.forEach((session, index) => {
      for (const line of formatSessionSummary(session, index + 1, '')) {
        options.io.print(line.replace(' [current]', ''));
      }
    });
    return;
  }

  if (options.command === 'mcp' || options.command === 'commands' || options.command === 'skills') {
    await showClaudeDiscovery({
      cwd: options.cwd,
      io: options.io,
      mode: options.command as 'commands' | 'mcp' | 'skills',
    });
    return;
  }

  const session = await resolveCommandSession({
    cwd: options.cwd,
    provider: options.provider,
    resumeId: options.resumeId,
    store: options.store,
  });

  if (options.command === 'history') {
    await showHistory({
      io: options.io,
      provider: session.provider,
      rawArgs: options.rawArgs,
      session,
      store: options.store,
    });
    return;
  }

  if (options.command === 'transcript') {
    await showTranscript({
      io: options.io,
      provider: session.provider,
      rawArgs: options.rawArgs,
      session,
      store: options.store,
    });
    return;
  }

  if (options.command === 'export') {
    const filePath = await exportSessionSnapshot({
      cwd: options.cwd,
      outputArgs: options.rawArgs,
      session,
      store: options.store,
    });
    options.io.print(filePath);
  }
}

function buildManagementRawArgs(options: {
  command: string;
  html?: boolean;
  json?: boolean;
  markdown?: boolean;
  positionals: string[];
}): string {
  const args = [...options.positionals.slice(1)];

  if (options.command === 'export') {
    if (options.json) {
      args.unshift('--json');
    }
    if (options.markdown) {
      args.unshift('--markdown');
    }
    if (options.html) {
      args.unshift('--html');
    }
  }

  return args.join(' ');
}

function parseManagementCliArgs(argv: string[]): {
  command: string;
  cwd?: string;
  html: boolean;
  json: boolean;
  markdown: boolean;
  provider?: string;
  rawPositionals: string[];
  resumeId?: string;
} {
  const command = argv[0] || '';
  const rawPositionals: string[] = [];
  let cwd: string | undefined;
  let provider: string | undefined;
  let resumeId: string | undefined;
  let html = false;
  let json = false;
  let markdown = false;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index] || '';
    if (token === '--cwd') {
      cwd = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--provider') {
      provider = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--resume') {
      resumeId = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--html') {
      html = true;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--markdown') {
      markdown = true;
      continue;
    }
    rawPositionals.push(token);
  }

  return {
    command,
    cwd,
    html,
    json,
    markdown,
    provider,
    rawPositionals,
    resumeId,
  };
}

function printChatHelp(io: TerminalIO): void {
  io.print('Interactive commands:');
  io.print('  /help                           Show chat commands');
  io.print('  /session                        Show current session id');
  io.print('  /sessions [query]               List recent sessions, optionally filtered');
  io.print('  /use [id|n|query]               Switch to another saved session');
  io.print('  /rename [title]                 Rename the current session');
  io.print('  /export [--json|--markdown|--html] [path]');
  io.print('                                   Export the current session');
  io.print('  /history [limit]                Show recent conversation history');
  io.print('  /transcript [source] [limit]    Show transcript entries');
  io.print('                                   source: anthropic|main|planner|reviewer|all');
  io.print('  /commands                       List discovered Claude custom commands');
  io.print('  /skills                         List discovered Claude skills');
  io.print('  /mcp                            List discovered Claude MCP config and servers');
  io.print('  Approval prompts support: allow once, allow session, always allow,');
  io.print('                                   deny once, always deny in workspace');
  io.print('  /stop                           Cancel the current running turn');
  io.print('  Ctrl+C                           Cancel the current running turn');
  io.print('  /clear                          Clear history for the current session');
  io.print('  /new                            Start a new session in this workspace');
  io.print('  /delete [target]                Delete the current or a selected session');
  io.print('  /exit                           Exit chat');
  io.print('  /quit                           Exit chat');
}

async function runChatLoop(options: {
  approvalMode: ApprovalMode;
  approvalStore: ApprovalStore;
  config: AppConfig;
  cwd: string;
  initialPrompt: string;
  io: TerminalIO;
  maxTurns: number;
  provider: ProviderMode;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<void> {
  if (!options.io.supportsInteraction()) {
    throw new Error('Chat mode requires an interactive terminal.');
  }

  let session = options.session;
  updateIoContext({
    approvalMode: options.approvalMode,
    cwd: options.cwd,
    io: options.io,
    provider: options.provider,
    session,
  });
  await updateSidebarSessions({
    currentSessionId: session.id,
    cwd: options.cwd,
    io: options.io,
    provider: options.provider,
    store: options.store,
  });
  options.io.setStatus('idle');
  options.io.printTag('session', sessionLabel(session), 'muted');
  options.io.printTag('provider', options.provider, 'muted');
  options.io.print('Type /help for chat commands.');

  if (options.initialPrompt) {
    session = await executeTurn({
      ...options,
      prompt: options.initialPrompt,
      session,
      streamOutput: true,
    });
    updateIoContext({
      approvalMode: options.approvalMode,
      cwd: options.cwd,
      io: options.io,
      provider: options.provider,
      session,
    });
    await updateSidebarSessions({
      currentSessionId: session.id,
      cwd: options.cwd,
      io: options.io,
      provider: options.provider,
      store: options.store,
    });
  }

  while (true) {
    options.io.print('');
    const prompt = (await options.io.ask(options.io.prefix('you', 'user'))).trim();
    if (!prompt) {
      continue;
    }

    const command = parseChatCommand(prompt);

    if (command?.name === 'exit' || command?.name === 'quit') {
      options.io.success('Exiting chat.');
      return;
    }

    if (command?.name === 'help' || command?.name === '') {
      printChatHelp(options.io);
      continue;
    }

    if (command?.name === 'session') {
      options.io.printTag('session', sessionLabel(session), 'muted');
      continue;
    }

    if (command?.name === 'stop') {
      options.io.warn('No run is currently in progress.');
      continue;
    }

    if (command?.name === 'sessions') {
      await printRecentSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        query: command.args,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'use') {
      const selected = await resolveSessionReference({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        rawArgs: command.args,
        store: options.store,
      });

      if (!selected) {
        options.io.warn(
          command.args.trim()
            ? `No session matched '${command.args.trim()}'.`
            : 'No session selected.'
        );
        continue;
      }

      session = selected;
      options.io.success(`Switched to session: ${sessionLabel(session)}`);
      updateIoContext({
        approvalMode: options.approvalMode,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        session,
      });
      await updateSidebarSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'rename') {
      session = await renameCurrentSession({
        io: options.io,
        rawArgs: command.args,
        session,
        store: options.store,
      });
      updateIoContext({
        approvalMode: options.approvalMode,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        session,
      });
      await updateSidebarSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'export') {
      const filePath = await exportSessionSnapshot({
        cwd: options.cwd,
        outputArgs: command.args,
        session,
        store: options.store,
      });
      options.io.success(`Exported session to ${filePath}`);
      continue;
    }

    if (command?.name === 'commands') {
      await showClaudeDiscovery({ cwd: options.cwd, io: options.io, mode: 'commands' });
      continue;
    }

    if (command?.name === 'skills') {
      await showClaudeDiscovery({ cwd: options.cwd, io: options.io, mode: 'skills' });
      continue;
    }

    if (command?.name === 'mcp') {
      await showClaudeDiscovery({ cwd: options.cwd, io: options.io, mode: 'mcp' });
      continue;
    }

    if (command?.name === 'history') {
      await showHistory({
        io: options.io,
        provider: options.provider,
        rawArgs: command.args,
        session,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'transcript') {
      await showTranscript({
        io: options.io,
        provider: options.provider,
        rawArgs: command.args,
        session,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'clear') {
      const confirmed = await options.io.confirm(
        'Clear history for the current session?'
      );
      if (!confirmed) {
        continue;
      }

      session = await clearSessionHistoryEverywhere({
        io: options.io,
        session,
        store: options.store,
      });
      options.io.success(`Cleared session history: ${sessionLabel(session)}`);
      updateIoContext({
        approvalMode: options.approvalMode,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        session,
      });
      await updateSidebarSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'new') {
      session = await options.store.create({
        cwd: options.cwd,
        provider: options.provider,
      });
      options.io.success(`Started new session: ${sessionLabel(session)}`);
      updateIoContext({
        approvalMode: options.approvalMode,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        session,
      });
      await updateSidebarSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        store: options.store,
      });
      continue;
    }

    if (command?.name === 'delete') {
      session = await deleteSelectedSession({
        currentSession: session,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        rawArgs: command.args,
        store: options.store,
      });
      updateIoContext({
        approvalMode: options.approvalMode,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        session,
      });
      await updateSidebarSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        store: options.store,
      });
      continue;
    }

    if (command && !isCustomSlashCommand(prompt, options.provider)) {
      options.io.warn(`Unknown command: /${command.name}`);
      continue;
    }

    options.io.printTag('you', prompt, 'user');

    try {
      session = await executeTurn({
        ...options,
        prompt,
        session,
        streamOutput: true,
      });
      updateIoContext({
        approvalMode: options.approvalMode,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        session,
      });
      await updateSidebarSessions({
        currentSessionId: session.id,
        cwd: options.cwd,
        io: options.io,
        provider: options.provider,
        store: options.store,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Run cancelled by user.') {
        options.io.warn('Run cancelled.');
        options.io.setStatus('idle');
        continue;
      }
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv.length > 0 && MANAGEMENT_COMMANDS.has(rawArgv[0] || '')) {
    const parsed = parseManagementCliArgs(rawArgv);
    const io = new TerminalIO();
    const config = loadAppConfig();
    const store = new MetadataStore(config.appHome);

    try {
      await runManagementCommand({
        command: parsed.command,
        cwd: path.resolve(parsed.cwd || process.cwd()),
        io,
        provider: parsed.provider ? parseProvider(parsed.provider) : undefined,
        rawArgs: buildManagementRawArgs({
          command: parsed.command,
          html: parsed.html,
          json: parsed.json,
          markdown: parsed.markdown,
          positionals: [parsed.command, ...parsed.rawPositionals],
        }),
        resumeId: parsed.resumeId,
        store,
      });
      return;
    } finally {
      io.dispose();
    }
  }

  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      approval: { type: 'string' },
      chat: { type: 'boolean' },
      cwd: { type: 'string' },
      html: { type: 'boolean' },
      help: { type: 'boolean' },
      json: { type: 'boolean' },
      markdown: { type: 'boolean' },
      'max-turns': { type: 'string' },
      provider: { type: 'string' },
      resume: { type: 'string' },
      tui: { type: 'boolean' },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const chatMode = values.chat === true;
  const tuiMode = values.tui === true;
  const managementCommand =
    !chatMode && positionals.length > 0 && MANAGEMENT_COMMANDS.has(positionals[0] || '');
  const prompt = managementCommand ? '' : await readPrompt(positionals);
  if (!prompt && !chatMode && !managementCommand) {
    printHelp();
    throw new Error('A prompt is required.');
  }

  if (tuiMode && !chatMode) {
    throw new Error('--tui currently requires --chat.');
  }

  const io: TerminalIO = tuiMode ? new TuiIO() : new TerminalIO();
  const config = loadAppConfig();
  const approvalStore = new ApprovalStore(config.appHome);
  const store = new MetadataStore(config.appHome);
  const providerFlag = parseProvider(values.provider);
  const cwd = path.resolve(String(values.cwd || process.cwd()));
  const approvalMode = parseApprovalMode(
    typeof values.approval === 'string' ? values.approval : undefined
  );
  const maxTurns = parsePositiveInt(
    typeof values['max-turns'] === 'string' ? values['max-turns'] : undefined,
    20
  );

  if (managementCommand) {
    try {
      await runManagementCommand({
        command: positionals[0] || '',
        cwd,
        io,
        provider: providerFlag,
        rawArgs: buildManagementRawArgs({
          command: positionals[0] || '',
          html: values.html === true,
          json: values.json === true,
          markdown: values.markdown === true,
          positionals,
        }),
        resumeId: typeof values.resume === 'string' ? values.resume : undefined,
        store,
      });
      return;
    } finally {
      io.dispose();
    }
  }

  const session = await store.loadOrCreate({
    cwd,
    provider: providerFlag,
    resumeId: typeof values.resume === 'string' ? values.resume : undefined,
  });
  const provider = providerFlag || session.provider;

  assertCredentials(provider);

  updateIoContext({ approvalMode, cwd, io, provider, session });

  try {
    if (chatMode) {
      await runChatLoop({
        approvalMode,
        approvalStore,
        config,
        cwd,
        initialPrompt: prompt,
        io,
        maxTurns,
        provider,
        session,
        store,
      });
      return;
    }

    const nextSession = await executeTurn({
      approvalMode,
      approvalStore,
      config,
      cwd,
      io,
      maxTurns,
      prompt,
      provider,
      session,
      store,
      streamOutput: false,
    });

    io.print(`Session: ${sessionLabel(nextSession)}`);
  } finally {
    io.dispose();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'Run cancelled by user.') {
    console.error('Run cancelled.');
    process.exitCode = 130;
    return;
  }
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
