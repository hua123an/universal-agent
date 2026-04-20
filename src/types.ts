import type { AppConfig } from './config.js';
import type { ApprovalStore } from './approvals/store.js';
import type { ApprovalRule } from './approvals/policy.js';
import type { MetadataStore } from './sessions/metadata-store.js';
import type { TerminalIO } from './utils/prompt.js';

export type ProviderMode = 'anthropic' | 'openai' | 'hybrid';

export type ApprovalMode = 'auto' | 'prompt';

export interface ProviderUsageEntry {
  costUSD?: number;
  inputTokens: number;
  lane: string;
  outputTokens: number;
  provider: 'anthropic' | 'openai';
  requests: number;
  totalTokens: number;
  turns?: number;
}

export interface SessionUsageBucket {
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  runs: number;
  totalTokens: number;
}

export interface SessionUsageTotals extends SessionUsageBucket {
  byProvider: Partial<Record<'anthropic' | 'openai', SessionUsageBucket>>;
}

export interface SessionMetadata {
  approvalRules?: ApprovalRule[];
  anthropicSessionId?: string;
  id: string;
  cwd: string;
  createdAt: string;
  lastRunDegraded?: boolean;
  lastRunNotes?: string;
  lastRunProvider?: ProviderMode;
  lastPromptPreview?: string;
  lastUsageEntries?: ProviderUsageEntry[];
  provider: ProviderMode;
  title?: string;
  updatedAt: string;
  usageTotals?: SessionUsageTotals;
}

export interface ProviderRunRequest {
  approvalMode: ApprovalMode;
  approvalStore: ApprovalStore;
  config: AppConfig;
  cwd: string;
  io: TerminalIO;
  maxTurns: number;
  prompt: string;
  session: SessionMetadata;
  signal?: AbortSignal;
  store: MetadataStore;
  streamOutput: boolean;
}

export interface ProviderRunResult {
  metadata?: Partial<SessionMetadata>;
  streamed?: boolean;
  text: string;
  usageEntries?: ProviderUsageEntry[];
}

export interface HybridPlan {
  executionPrompt: string;
  focus: string[];
  risks: string[];
  summary: string;
}

export interface HybridReview {
  concerns: string[];
  nextSteps: string[];
  summary: string;
  verdict: 'ok' | 'caution';
}
