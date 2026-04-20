import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Shell, ShellAction, ShellOutputResult, ShellResult } from '@openai/agents';
import { truncate } from '../utils/text.js';

const execFileAsync = promisify(execFile);

export class WorkspaceShell implements Shell {
  constructor(private readonly workspaceRoot: string) {}

  async run(action: ShellAction): Promise<ShellResult> {
    const maxOutputLength = action.maxOutputLength ?? 12000;
    const output: ShellOutputResult[] = [];

    for (const command of action.commands) {
      output.push(
        await this.runCommand(command, action.timeoutMs ?? 120000, maxOutputLength)
      );
    }

    return { maxOutputLength, output };
  }

  private async runCommand(
    command: string,
    timeoutMs: number,
    maxOutputLength: number
  ): Promise<ShellOutputResult> {
    try {
      const result = await execFileAsync('bash', ['-lc', command], {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
        timeout: timeoutMs,
      });

      return {
        outcome: { exitCode: 0, type: 'exit' },
        stderr: truncate(result.stderr ?? '', maxOutputLength),
        stdout: truncate(result.stdout ?? '', maxOutputLength),
      };
    } catch (error) {
      const failure = error as {
        code?: number | string;
        killed?: boolean;
        message?: string;
        signal?: NodeJS.Signals;
        stderr?: string;
        stdout?: string;
      };

      if (failure.killed || failure.signal === 'SIGTERM') {
        return {
          outcome: { type: 'timeout' },
          stderr: truncate(failure.stderr ?? failure.message ?? '', maxOutputLength),
          stdout: truncate(failure.stdout ?? '', maxOutputLength),
        };
      }

      return {
        outcome: {
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          type: 'exit',
        },
        stderr: truncate(failure.stderr ?? failure.message ?? '', maxOutputLength),
        stdout: truncate(failure.stdout ?? '', maxOutputLength),
      };
    }
  }
}
