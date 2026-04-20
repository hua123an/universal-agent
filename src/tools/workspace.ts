import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveWorkspacePath } from '../utils/path.js';
import { truncate } from '../utils/text.js';

const execFileAsync = promisify(execFile);

export class Workspace {
  constructor(public readonly root: string) {}

  async readFileRange(
    filePath: string,
    offset = 1,
    limit = 200
  ): Promise<string> {
    const absolute = resolveWorkspacePath(this.root, filePath);
    const raw = await fs.readFile(absolute, 'utf8');
    const lines = raw.split(/\r?\n/);
    const start = Math.max(offset, 1);
    const selected = lines.slice(start - 1, start - 1 + limit);

    if (selected.length === 0) {
      return '[No lines in requested range]';
    }

    return selected
      .map((line, index) => `${start + index}: ${truncate(line, 2000)}`)
      .join('\n');
  }

  async globFiles(pattern: string, limit = 200): Promise<string[]> {
    const args = ['--files'];
    if (pattern && pattern !== '**/*') {
      args.push('-g', pattern);
    }

    return this.runRipgrep(args, limit);
  }

  async grepFiles(
    pattern: string,
    include = '*',
    limit = 200
  ): Promise<string[]> {
    const args = ['-n', '--no-heading', '--color', 'never'];
    if (include && include !== '*') {
      args.push('-g', include);
    }
    args.push(pattern, '.');

    return this.runRipgrep(args, limit);
  }

  async listWorkspace(limit = 200): Promise<string[]> {
    return this.globFiles('**/*', limit);
  }

  private async runRipgrep(args: string[], limit: number): Promise<string[]> {
    try {
      const result = await execFileAsync('rg', args, {
        cwd: this.root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      return result.stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .slice(0, limit);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 1
      ) {
        return [];
      }

      throw error;
    }
  }
}
