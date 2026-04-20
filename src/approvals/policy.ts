import path from 'node:path';
import type { ApplyPatchOperation } from '@openai/agents';
import type { ShellAction } from '@openai/agents';
import type { ApprovalMode, ProviderMode, SessionMetadata } from '../types.js';
import type { MetadataStore } from '../sessions/metadata-store.js';
import type { ApprovalStore } from './store.js';
import type { TerminalIO } from '../utils/prompt.js';
import { isPathInside } from '../utils/path.js';

export type ApprovalEffect = 'allow' | 'deny';
export type ApprovalKind = 'other' | 'question' | 'shell' | 'write';

export interface ApprovalRule {
  commandPrefix?: string;
  effect: ApprovalEffect;
  kind?: ApprovalKind;
  path?: string;
  provider?: ProviderMode;
  toolName?: string;
}

export interface ApprovalRequest {
  commands: string[];
  cwd: string;
  kind: ApprovalKind;
  paths: string[];
  provider: ProviderMode;
  toolName: string;
}

export interface ApprovalEvaluation {
  effect: 'allow' | 'deny' | 'prompt';
}

type ApprovalChoice =
  | 'allow_once'
  | 'allow_session'
  | 'allow_workspace'
  | 'deny_once'
  | 'deny_workspace';

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizePath(cwd: string, value: string): string | null {
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(cwd, value);

  if (!isPathInside(cwd, absolute)) {
    return null;
  }

  return toPosixPath(path.relative(cwd, absolute) || '.');
}

function classifyAnthropicKind(toolName: string): ApprovalKind {
  if (toolName === 'AskUserQuestion') {
    return 'question';
  }
  if (toolName === 'Bash') {
    return 'shell';
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return 'write';
  }
  return 'other';
}

function extractAnthropicPaths(cwd: string, input: Record<string, unknown>): string[] {
  const candidates = [
    input.file_path,
    input.path,
    input.notebook_path,
    input.target_file,
  ].filter((value): value is string => typeof value === 'string');

  return candidates
    .map((candidate) => normalizePath(cwd, candidate))
    .filter((value): value is string => Boolean(value));
}

function matchPath(rulePath: string, candidate: string): boolean {
  const normalizedRule = toPosixPath(rulePath);
  return normalizedRule.endsWith('/')
    ? candidate === normalizedRule.slice(0, -1) || candidate.startsWith(normalizedRule)
    : candidate === normalizedRule;
}

function matchesBase(rule: ApprovalRule, request: ApprovalRequest): boolean {
  if (rule.provider && rule.provider !== request.provider) {
    return false;
  }
  if (rule.kind && rule.kind !== request.kind) {
    return false;
  }
  if (rule.toolName && rule.toolName !== request.toolName) {
    return false;
  }
  return true;
}

function matchCommands(effect: ApprovalEffect, rules: ApprovalRule[], request: ApprovalRequest): boolean {
  if (request.commands.length === 0) {
    return false;
  }

  const relevant = rules.filter(
    (rule) => rule.effect === effect && matchesBase(rule, request) && rule.commandPrefix
  );
  if (relevant.length === 0) {
    return false;
  }

  return request.commands.every((command) =>
    relevant.some((rule) => command.startsWith(rule.commandPrefix || ''))
  );
}

function matchPaths(effect: ApprovalEffect, rules: ApprovalRule[], request: ApprovalRequest): boolean {
  if (request.paths.length === 0) {
    return false;
  }

  const relevant = rules.filter(
    (rule) => rule.effect === effect && matchesBase(rule, request) && rule.path
  );
  if (relevant.length === 0) {
    return false;
  }

  return request.paths.every((candidate) =>
    relevant.some((rule) => matchPath(rule.path || '', candidate))
  );
}

function matchGeneric(effect: ApprovalEffect, rules: ApprovalRule[], request: ApprovalRequest): boolean {
  return rules.some(
    (rule) =>
      rule.effect === effect &&
      matchesBase(rule, request) &&
      !rule.commandPrefix &&
      !rule.path
  );
}

export function evaluateApprovalRequest(
  request: ApprovalRequest,
  rules: ApprovalRule[]
): ApprovalEvaluation {
  if (matchCommands('deny', rules, request) || matchPaths('deny', rules, request) || matchGeneric('deny', rules, request)) {
    return { effect: 'deny' };
  }

  if (matchCommands('allow', rules, request) || matchPaths('allow', rules, request) || matchGeneric('allow', rules, request)) {
    return { effect: 'allow' };
  }

  return { effect: 'prompt' };
}

function buildRulesFromRequest(
  request: ApprovalRequest,
  effect: ApprovalEffect
): ApprovalRule[] {
  if (request.commands.length > 0) {
    return request.commands.map((command) => ({
      commandPrefix: command,
      effect,
      kind: request.kind,
      provider: request.provider,
      toolName: request.toolName,
    }));
  }

  if (request.paths.length > 0) {
    return request.paths.map((filePath) => ({
      effect,
      kind: request.kind,
      path: filePath,
      provider: request.provider,
      toolName: request.toolName,
    }));
  }

  return [
    {
      effect,
      kind: request.kind,
      provider: request.provider,
      toolName: request.toolName,
    },
  ];
}

export function buildAnthropicApprovalRequest(options: {
  cwd: string;
  input: Record<string, unknown>;
  provider: ProviderMode;
  toolName: string;
}): ApprovalRequest {
  const commands =
    options.toolName === 'Bash' && typeof options.input.command === 'string'
      ? [normalizeCommand(options.input.command)]
      : [];

  return {
    commands,
    cwd: options.cwd,
    kind: classifyAnthropicKind(options.toolName),
    paths: extractAnthropicPaths(options.cwd, options.input),
    provider: options.provider,
    toolName: options.toolName,
  };
}

export function buildOpenAIShellApprovalRequest(options: {
  action: ShellAction;
  cwd: string;
  provider: ProviderMode;
}): ApprovalRequest {
  return {
    commands: options.action.commands.map((command) => normalizeCommand(command)),
    cwd: options.cwd,
    kind: 'shell',
    paths: [],
    provider: options.provider,
    toolName: 'shell',
  };
}

export function buildOpenAIApplyPatchApprovalRequest(options: {
  cwd: string;
  operation: ApplyPatchOperation;
  provider: ProviderMode;
}): ApprovalRequest {
  const normalizedPath = normalizePath(options.cwd, options.operation.path);
  return {
    commands: [],
    cwd: options.cwd,
    kind: 'write',
    paths: normalizedPath ? [normalizedPath] : [],
    provider: options.provider,
    toolName: 'apply_patch',
  };
}

export function describeApprovalRequest(request: ApprovalRequest): string {
  if (request.commands.length > 0) {
    return `${request.toolName}: ${request.commands.join(' && ')}`;
  }

  if (request.paths.length > 0) {
    return `${request.toolName}: ${request.paths.join(', ')}`;
  }

  return request.toolName;
}

export async function resolveApprovalRequest(options: {
  approvalMode: ApprovalMode;
  approvalStore: ApprovalStore;
  io: TerminalIO;
  request: ApprovalRequest;
  session: SessionMetadata;
  store: MetadataStore;
}): Promise<'allow' | 'deny'> {
  const sessionRules = options.session.approvalRules || [];
  const workspaceRules = await options.approvalStore.getWorkspaceRules(options.request.cwd);
  const evaluation = evaluateApprovalRequest(options.request, [
    ...sessionRules,
    ...workspaceRules,
  ]);

  if (evaluation.effect === 'allow') {
    return 'allow';
  }

  if (evaluation.effect === 'deny') {
    return 'deny';
  }

  if (options.approvalMode === 'auto') {
    return 'allow';
  }

  if (!options.io.supportsInteraction()) {
    return 'deny';
  }

  const choice = await options.io.select<ApprovalChoice>(
    `Approval required for ${describeApprovalRequest(options.request)}`,
    [
      { label: 'Allow once', value: 'allow_once' },
      { label: 'Allow for session', value: 'allow_session' },
      { label: 'Always allow in workspace', value: 'allow_workspace' },
      { label: 'Deny once', value: 'deny_once' },
      { label: 'Always deny in workspace', value: 'deny_workspace' },
    ]
  );

  if (choice === 'allow_once') {
    return 'allow';
  }

  if (choice === 'deny_once') {
    return 'deny';
  }

  const rules = buildRulesFromRequest(
    options.request,
    choice === 'allow_session' || choice === 'allow_workspace' ? 'allow' : 'deny'
  );

  if (choice === 'allow_session') {
    options.session.approvalRules = [...sessionRules, ...rules];
    await options.store.save(options.session);
    return 'allow';
  }

  await options.approvalStore.addWorkspaceRules(options.request.cwd, rules);
  return choice === 'allow_workspace' ? 'allow' : 'deny';
}
