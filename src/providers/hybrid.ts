import { runAnthropicCodingAgent } from './anthropic.js';
import {
  runOpenAIPlanner,
  runOpenAIReviewer,
} from './openai.js';
import type {
  HybridPlan,
  HybridReview,
  ProviderUsageEntry,
  ProviderRunRequest,
  ProviderRunResult,
} from '../types.js';

function isCancellation(request: ProviderRunRequest, error: unknown): boolean {
  return Boolean(
    request.signal?.aborted ||
      (error instanceof Error && /abort|cancel/i.test(error.message))
  );
}

function buildExecutionPrompt(prompt: string, plan: HybridPlan): string {
  return `Original request:
${prompt}

OpenAI planning brief:
Summary: ${plan.summary}

Focus areas:
${plan.focus.map((item) => `- ${item}`).join('\n')}

Known risks:
${(plan.risks.length > 0 ? plan.risks : ['No special risks noted.'])
  .map((item) => `- ${item}`)
  .join('\n')}

Execution brief:
${plan.executionPrompt}

Carry out the work in the current workspace. Make the smallest correct changes, and verify the result when practical.`;
}

function buildReviewPrompt(
  prompt: string,
  plan: HybridPlan | null,
  executionText: string
): string {
  return `Original request:
${prompt}

Planning brief:
${plan ? plan.summary : 'Planner unavailable.'}

Anthropic executor summary:
${executionText}

Review the current workspace state against the original request. Surface any correctness risks, missing work, or likely regressions.`;
}

function formatHybridResult(
  plan: HybridPlan | null,
  executionText: string,
  review: HybridReview | null
): string {
  const sections = ['# Hybrid Run'];

  if (plan) {
    sections.push(
      '',
      '## Plan',
      plan.summary,
      '',
      'Focus:',
      ...plan.focus.map((item) => `- ${item}`),
      '',
      'Risks:',
      ...(plan.risks.length > 0
        ? plan.risks.map((item) => `- ${item}`)
        : ['- None called out by the planner.'])
    );
  }

  sections.push('', '## Execution', executionText);

  if (review) {
    sections.push(
      '',
      '## Review',
      `Verdict: ${review.verdict}`,
      review.summary,
      '',
      'Concerns:',
      ...(review.concerns.length > 0
        ? review.concerns.map((item) => `- ${item}`)
        : ['- No major concerns surfaced.']),
      '',
      'Next steps:',
      ...(review.nextSteps.length > 0
        ? review.nextSteps.map((item) => `- ${item}`)
        : ['- No follow-up suggested.'])
    );
  }

  return sections.join('\n');
}

export async function runHybridAgent(
  request: ProviderRunRequest
): Promise<ProviderRunResult> {
  let plan: HybridPlan | null = null;
  const usageEntries: ProviderUsageEntry[] = [];

  if (request.streamOutput) {
    request.io.printTag('planner', 'analyzing workspace', 'planner');
  }

  try {
    const planned = await runOpenAIPlanner(request);
    plan = planned.plan;
    usageEntries.push(...planned.usageEntries);
    if (request.streamOutput) {
      request.io.printTag('planner', plan.summary, 'planner');
    }
  } catch (error) {
    if (isCancellation(request, error)) {
      throw error;
    }
    request.io.warn(
      `OpenAI planner failed, continuing without it: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const executionPrompt = plan
    ? buildExecutionPrompt(request.prompt, plan)
    : request.prompt;
  if (request.streamOutput) {
    request.io.write(request.io.prefix('executor', 'executor'));
  }
  const execution = await runAnthropicCodingAgent({
    ...request,
    prompt: executionPrompt,
  });
  if (execution.usageEntries) {
    usageEntries.push(...execution.usageEntries);
  }

  if (request.streamOutput && execution.streamed && !execution.text.endsWith('\n')) {
    request.io.print('');
  }

  let review: HybridReview | null = null;
  if (request.streamOutput) {
    request.io.printTag('reviewer', 'checking current workspace', 'reviewer');
  }
  try {
    const reviewed = await runOpenAIReviewer(
      request,
      buildReviewPrompt(request.prompt, plan, execution.text)
    );
    review = reviewed.review;
    usageEntries.push(...reviewed.usageEntries);
    if (request.streamOutput) {
      request.io.printTag('reviewer', `verdict=${review.verdict}`, 'reviewer');
      request.io.printTag('reviewer', review.summary, 'reviewer');
      if (review.concerns.length > 0) {
        request.io.printTag(
          'reviewer',
          `concerns: ${review.concerns.join(' | ')}`,
          'reviewer'
        );
      }
    }
  } catch (error) {
    if (isCancellation(request, error)) {
      throw error;
    }
    request.io.warn(
      `OpenAI reviewer failed, returning execution result without review: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    metadata: {
      ...execution.metadata,
      lastRunDegraded:
        Boolean(plan === null || review === null || execution.metadata?.lastRunDegraded),
      lastRunNotes: [
        plan === null ? 'planner_unavailable' : null,
        review === null ? 'reviewer_unavailable' : null,
        execution.metadata?.lastRunDegraded ? execution.metadata.lastRunNotes || 'executor_degraded' : null,
      ]
        .filter(Boolean)
        .join(', ') || undefined,
      lastRunProvider: 'hybrid',
    },
    streamed: request.streamOutput,
    text: formatHybridResult(plan, execution.text, review),
    usageEntries,
  };
}
