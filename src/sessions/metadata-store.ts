import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProviderMode, SessionMetadata } from '../types.js';

export class MetadataStore {
  constructor(private readonly baseDir: string) {}

  async create(options: {
    cwd: string;
    provider: ProviderMode;
  }): Promise<SessionMetadata> {
    return this.loadOrCreate(options);
  }

  async loadOrCreate(options: {
    cwd: string;
    provider?: ProviderMode;
    resumeId?: string;
  }): Promise<SessionMetadata> {
    await this.init();

    if (options.resumeId) {
      const existing = await this.load(options.resumeId);
      if (!existing) {
        throw new Error(`Session not found: ${options.resumeId}`);
      }

      if (options.provider && options.provider !== existing.provider) {
        throw new Error(
          `Session ${options.resumeId} belongs to provider '${existing.provider}', not '${options.provider}'.`
        );
      }

      if (path.resolve(options.cwd) !== path.resolve(existing.cwd)) {
        throw new Error(
          `Session ${options.resumeId} belongs to cwd '${existing.cwd}', not '${options.cwd}'.`
        );
      }

      return existing;
    }

    if (!options.provider) {
      throw new Error('A provider is required when starting a new session.');
    }

    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      createdAt: now,
      cwd: options.cwd,
      id: randomUUID(),
      provider: options.provider,
      updatedAt: now,
    };

    await this.save(metadata);
    return metadata;
  }

  async load(sessionId: string): Promise<SessionMetadata | null> {
    try {
      const raw = await fs.readFile(this.getMetadataPath(sessionId), 'utf8');
      return JSON.parse(raw) as SessionMetadata;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }

      throw error;
    }
  }

  async save(metadata: SessionMetadata): Promise<void> {
    await this.init();
    metadata.updatedAt = new Date().toISOString();
    await fs.writeFile(
      this.getMetadataPath(metadata.id),
      JSON.stringify(metadata, null, 2)
    );
  }

  async clearHistory(metadata: SessionMetadata): Promise<SessionMetadata> {
    await this.init();
    const next: SessionMetadata = {
      ...metadata,
      anthropicSessionId: undefined,
      lastPromptPreview: undefined,
    };

    const entries = await fs.readdir(this.getItemsDir(), { withFileTypes: true });
    const prefix = `${metadata.id}.`;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) {
        continue;
      }

      await fs.rm(path.join(this.getItemsDir(), entry.name));
    }

    await this.save(next);
    return next;
  }

  async delete(metadata: SessionMetadata): Promise<void> {
    await this.init();

    const entries = await fs.readdir(this.getItemsDir(), { withFileTypes: true });
    const prefix = `${metadata.id}.`;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) {
        continue;
      }

      await fs.rm(path.join(this.getItemsDir(), entry.name), { force: true });
    }

    await fs.rm(this.getMetadataPath(metadata.id), { force: true });
  }

  async rename(metadata: SessionMetadata, title: string): Promise<SessionMetadata> {
    const next: SessionMetadata = {
      ...metadata,
      title: title.trim() || undefined,
    };

    await this.save(next);
    return next;
  }

  async readOpenAILanes(sessionId: string): Promise<Record<string, unknown>> {
    await this.init();

    const entries = await fs.readdir(this.getItemsDir(), { withFileTypes: true });
    const prefix = `${sessionId}.`;
    const lanes: Record<string, unknown> = {};

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith('.json')) {
        continue;
      }

      const lane = entry.name.slice(prefix.length, -'.json'.length);
      try {
        const raw = await fs.readFile(path.join(this.getItemsDir(), entry.name), 'utf8');
        lanes[lane] = JSON.parse(raw);
      } catch {
        lanes[lane] = { error: 'Failed to read lane file.' };
      }
    }

    return lanes;
  }

  async listRecent(options?: {
    cwd?: string;
    limit?: number;
    provider?: ProviderMode;
    query?: string;
  }): Promise<SessionMetadata[]> {
    await this.init();

    const entries = await fs.readdir(this.getSessionsDir(), { withFileTypes: true });
    const sessions: SessionMetadata[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }

      try {
        const raw = await fs.readFile(
          path.join(this.getSessionsDir(), entry.name),
          'utf8'
        );
        const metadata = JSON.parse(raw) as SessionMetadata;

        if (
          options?.cwd &&
          path.resolve(metadata.cwd) !== path.resolve(options.cwd)
        ) {
          continue;
        }

        if (options?.provider && metadata.provider !== options.provider) {
          continue;
        }

        if (options?.query) {
          const needle = options.query.toLowerCase();
          const haystack = [
            metadata.id,
            metadata.title || '',
            metadata.lastPromptPreview || '',
            metadata.cwd,
          ]
            .join(' ')
            .toLowerCase();

          if (!haystack.includes(needle)) {
            continue;
          }
        }

        sessions.push(metadata);
      } catch {
        continue;
      }
    }

    sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );

    return sessions.slice(0, options?.limit ?? 20);
  }

  getOpenAISessionId(sessionId: string, lane: string): string {
    return `${sessionId}:${lane}`;
  }

  getOpenAISessionPath(sessionId: string, lane: string): string {
    return path.join(this.getItemsDir(), `${sessionId}.${lane}.json`);
  }

  private async init(): Promise<void> {
    await fs.mkdir(this.getSessionsDir(), { recursive: true });
    await fs.mkdir(this.getItemsDir(), { recursive: true });
  }

  private getItemsDir(): string {
    return path.join(this.baseDir, 'items');
  }

  private getMetadataPath(sessionId: string): string {
    return path.join(this.getSessionsDir(), `${sessionId}.json`);
  }

  private getSessionsDir(): string {
    return path.join(this.baseDir, 'sessions');
  }
}
