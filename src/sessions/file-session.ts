import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';

export interface StoredSessionEntry {
  item: AgentInputItem;
  recordedAt: string;
  sequence: number;
}

interface StoredSession {
  entries?: StoredSessionEntry[];
  items?: AgentInputItem[];
  nextSequence?: number;
  sessionId: string;
}

interface NormalizedStoredSession {
  entries: StoredSessionEntry[];
  nextSequence: number;
  sessionId: string;
}

export class JsonFileSession implements Session {
  constructor(
    private readonly filePath: string,
    private readonly fallbackSessionId: string
  ) {}

  async getSessionId(): Promise<string> {
    const data = await this.read();
    return data.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const data = await this.read();
    if (!limit || limit >= data.entries.length) {
      return data.entries.map((entry) => entry.item);
    }

    return data.entries.slice(-limit).map((entry) => entry.item);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const data = await this.read();
    const recordedAt = new Date().toISOString();
    items.forEach((item) => {
      data.entries.push({
        item,
        recordedAt,
        sequence: data.nextSequence++,
      });
    });
    await this.write(data);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const data = await this.read();
    const item = data.entries.pop()?.item;
    await this.write(data);
    return item;
  }

  async clearSession(): Promise<void> {
    await this.write({ entries: [], nextSequence: 1, sessionId: this.fallbackSessionId });
  }

  private async read(): Promise<NormalizedStoredSession> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return this.normalize(JSON.parse(raw) as StoredSession);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { entries: [], nextSequence: 1, sessionId: this.fallbackSessionId };
      }

      throw error;
    }
  }

  private normalize(data: StoredSession): NormalizedStoredSession {
    if (Array.isArray(data.entries)) {
      const nextSequence =
        typeof data.nextSequence === 'number'
          ? data.nextSequence
          : data.entries.reduce((max, entry) => Math.max(max, entry.sequence), 0) + 1;
      return {
        entries: data.entries,
        nextSequence,
        sessionId: data.sessionId || this.fallbackSessionId,
      };
    }

    const legacyItems = Array.isArray(data.items) ? data.items : [];
    return {
      entries: legacyItems.map((item, index) => ({
        item,
        recordedAt: '',
        sequence: index + 1,
      })),
      nextSequence: legacyItems.length + 1,
      sessionId: data.sessionId || this.fallbackSessionId,
    };
  }

  private async write(data: NormalizedStoredSession): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
