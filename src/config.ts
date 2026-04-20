import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { homedir } from 'node:os';

loadDotenv({ quiet: true });

export interface AppConfig {
  anthropicModel: string;
  appHome: string;
  openaiModel: string;
}

export function loadAppConfig(): AppConfig {
  return {
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    appHome:
      process.env.UNIVERSAL_AGENT_HOME ||
      path.join(homedir(), '.universal-agent'),
    openaiModel: process.env.OPENAI_MODEL || 'gpt-5',
  };
}

export function hasAnthropicCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_USE_BEDROCK === '1' ||
      process.env.CLAUDE_CODE_USE_VERTEX === '1' ||
      process.env.CLAUDE_CODE_USE_FOUNDRY === '1'
  );
}

export function hasOpenAICredentials(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}
