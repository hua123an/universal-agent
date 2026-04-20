import readline from 'node:readline/promises';
import { env, stdin, stdout } from 'node:process';

export type Tone =
  | 'assistant'
  | 'executor'
  | 'muted'
  | 'planner'
  | 'reviewer'
  | 'success'
  | 'tool'
  | 'user'
  | 'warning';

const ANSI_BY_TONE: Record<Tone, string> = {
  assistant: '\u001b[38;5;111m',
  executor: '\u001b[38;5;213m',
  muted: '\u001b[38;5;245m',
  planner: '\u001b[38;5;150m',
  reviewer: '\u001b[38;5;221m',
  success: '\u001b[38;5;120m',
  tool: '\u001b[38;5;177m',
  user: '\u001b[38;5;81m',
  warning: '\u001b[38;5;203m',
};

const ANSI_RESET = '\u001b[0m';

export class TerminalIO {
  dispose(): void {}

  setRunCancellation(_cancel: (() => void) | null): void {}

  setSidebarItems(_items: string[]): void {}

  setSessionContext(_context: {
    approvalMode: string;
    cwd: string;
    provider: string;
    sessionLabel: string;
  }): void {}

  setStatus(_status: string): void {}

  setUsageSummary(_summary: string): void {}

  supportsInteraction(): boolean {
    return Boolean(stdin.isTTY && stdout.isTTY);
  }

  supportsColor(): boolean {
    return Boolean(stdout.isTTY && env.NO_COLOR === undefined && env.TERM !== 'dumb');
  }

  async ask(message: string): Promise<string> {
    if (!this.supportsInteraction()) {
      throw new Error('Interactive input is required, but no TTY is available.');
    }

    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }

  async confirm(message: string): Promise<boolean> {
    const answer = (await this.ask(`${message} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }

  async select<T extends string>(
    message: string,
    options: Array<{ label: string; value: T }>
  ): Promise<T> {
    if (!this.supportsInteraction()) {
      throw new Error('Interactive input is required, but no TTY is available.');
    }

    this.print(message);
    options.forEach((option, index) => {
      this.print(`  ${index + 1}. ${option.label}`);
    });

    while (true) {
      const answer = (await this.ask('Choose: ')).trim();
      const index = Number.parseInt(answer, 10) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        const value = options[index]?.value;
        if (value) {
          return value;
        }
      }

      const direct = options.find(
        (option) => option.value === answer || option.label.toLowerCase() === answer.toLowerCase()
      );
      if (direct) {
        return direct.value;
      }

      this.warn('Invalid choice.');
    }
  }

  print(message = ''): void {
    stdout.write(message.endsWith('\n') ? message : `${message}\n`);
  }

  write(message: string): void {
    stdout.write(message);
  }

  prefix(label: string, tone: Tone = 'muted'): string {
    return `${this.colorize(label, tone)}> `;
  }

  printTag(label: string, message: string, tone: Tone = 'muted'): void {
    this.print(`${this.prefix(label, tone)}${message}`);
  }

  success(message: string): void {
    this.printTag('ok', message, 'success');
  }

  warn(message: string): void {
    this.printTag('warning', message, 'warning');
  }

  protected colorize(label: string, tone: Tone): string {
    if (!this.supportsColor()) {
      return label;
    }

    return `${ANSI_BY_TONE[tone]}${label}${ANSI_RESET}`;
  }
}
