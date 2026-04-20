import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApprovalRule } from './policy.js';

interface ApprovalStoreData {
  version: 1;
  workspaces: Record<string, { rules: ApprovalRule[] }>;
}

const DEFAULT_DATA: ApprovalStoreData = {
  version: 1,
  workspaces: {},
};

function dedupeRules(rules: ApprovalRule[]): ApprovalRule[] {
  const seen = new Set<string>();
  const result: ApprovalRule[] = [];

  for (const rule of rules) {
    const key = JSON.stringify(rule);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(rule);
  }

  return result;
}

export class ApprovalStore {
  private readonly filePath: string;

  constructor(appHome: string) {
    this.filePath = path.join(appHome, 'approvals.json');
  }

  async getWorkspaceRules(cwd: string): Promise<ApprovalRule[]> {
    const data = await this.read();
    return data.workspaces[path.resolve(cwd)]?.rules || [];
  }

  async addWorkspaceRules(cwd: string, rules: ApprovalRule[]): Promise<void> {
    const data = await this.read();
    const key = path.resolve(cwd);
    const existing = data.workspaces[key]?.rules || [];
    data.workspaces[key] = {
      rules: dedupeRules([...existing, ...rules]),
    };
    await this.write(data);
  }

  private async read(): Promise<ApprovalStoreData> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ApprovalStoreData;
      return parsed.version === 1 ? parsed : DEFAULT_DATA;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return DEFAULT_DATA;
      }

      throw error;
    }
  }

  private async write(data: ApprovalStoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
