import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { TerminalIO } from './prompt.js';

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) {
    return [line];
  }

  if (line.length <= width) {
    return [line];
  }

  const result: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    result.push(line.slice(index, index + width));
  }
  return result;
}

export class TuiIO extends TerminalIO {
  private buffer = '';
  private currentInput = '';
  private currentPrompt = '';
  private cursorIndex = 0;
  private keypressAttached = false;
  private readonly isEnabled: boolean;
  private promptResolver: ((value: string) => void) | null = null;
  private runCancellation: (() => void) | null = null;
  private runtimeCommand = '';
  private scrollOffset = 0;
  private sessionContext = {
    approvalMode: 'auto',
    cwd: '.',
    provider: 'unknown',
    sessionLabel: 'n/a',
  };
  private sidebarItems: string[] = [];
  private status = 'idle';
  private usageSummary = 'usage: n/a';

  constructor() {
    super();
    this.isEnabled = this.supportsInteraction();
    if (this.isEnabled) {
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', this.handleKeypress);
      this.keypressAttached = true;
      stdout.write('\u001b[?1049h\u001b[2J\u001b[H');
      this.render();
    }
  }

  dispose(): void {
    if (!this.isEnabled) {
      return;
    }

    if (this.keypressAttached) {
      stdin.off('keypress', this.handleKeypress);
      this.keypressAttached = false;
    }
    if (stdin.isTTY) {
      stdin.setRawMode(false);
    }
    stdout.write('\u001b[?1049l\u001b[?25h');
  }

  override setRunCancellation(cancel: (() => void) | null): void {
    this.runCancellation = cancel;
    if (!cancel) {
      this.runtimeCommand = '';
    }
    this.render();
  }

  override setSidebarItems(items: string[]): void {
    this.sidebarItems = items;
    this.render();
  }

  override setSessionContext(context: {
    approvalMode: string;
    cwd: string;
    provider: string;
    sessionLabel: string;
  }): void {
    this.sessionContext = context;
    this.render();
  }

  override setStatus(status: string): void {
    this.status = status;
    this.render();
  }

  override setUsageSummary(summary: string): void {
    this.usageSummary = summary;
    this.render();
  }

  override async ask(message: string): Promise<string> {
    if (!this.isEnabled) {
      return super.ask(message);
    }

    if (this.promptResolver) {
      throw new Error('TUI prompt is already active.');
    }

    this.currentInput = '';
    this.cursorIndex = 0;
    this.currentPrompt = message;
    this.render();

    return new Promise<string>((resolve) => {
      this.promptResolver = (value) => {
        this.promptResolver = null;
        this.currentInput = '';
        this.cursorIndex = 0;
        this.currentPrompt = '';
        this.render();
        resolve(value);
      };
    });
  }

  override print(message = ''): void {
    this.buffer += message.endsWith('\n') ? message : `${message}\n`;
    this.truncateBuffer();
    this.render();
  }

  override write(message: string): void {
    this.buffer += message;
    this.truncateBuffer();
    this.render();
  }

  private readonly handleKeypress = (character: string, key: { ctrl?: boolean; name?: string }): void => {
    if (!this.isEnabled) {
      return;
    }

    if (key.ctrl && key.name === 'c') {
      if (this.runCancellation) {
        this.printTag('control', 'Stopping current run...', 'warning');
        this.runCancellation();
      } else {
        this.dispose();
        process.exit(130);
      }
      return;
    }

    if (key.name === 'pageup') {
      this.scrollOffset = Math.min(this.scrollOffset + 10, 5000);
      this.render();
      return;
    }

    if (key.name === 'pagedown') {
      this.scrollOffset = Math.max(this.scrollOffset - 10, 0);
      this.render();
      return;
    }

    if (this.promptResolver) {
      this.handlePromptKeypress(character, key);
      return;
    }

    if (this.runCancellation) {
      this.handleRuntimeCommandKeypress(character, key);
      return;
    }

    if (key.name === 'up') {
      this.scrollOffset = Math.min(this.scrollOffset + 1, 5000);
      this.render();
      return;
    }

    if (key.name === 'down') {
      this.scrollOffset = Math.max(this.scrollOffset - 1, 0);
      this.render();
      return;
    }
  };

  private handlePromptKeypress(character: string, key: { name?: string }): void {
    if (key.name === 'return') {
      const value = this.currentInput;
      this.promptResolver?.(value);
      return;
    }

    if (key.name === 'left') {
      this.cursorIndex = Math.max(this.cursorIndex - 1, 0);
      this.render();
      return;
    }

    if (key.name === 'right') {
      this.cursorIndex = Math.min(this.cursorIndex + 1, this.currentInput.length);
      this.render();
      return;
    }

    if (key.name === 'home') {
      this.cursorIndex = 0;
      this.render();
      return;
    }

    if (key.name === 'end') {
      this.cursorIndex = this.currentInput.length;
      this.render();
      return;
    }

    if (key.name === 'backspace') {
      if (this.cursorIndex > 0) {
        this.currentInput =
          this.currentInput.slice(0, this.cursorIndex - 1) +
          this.currentInput.slice(this.cursorIndex);
        this.cursorIndex -= 1;
        this.render();
      }
      return;
    }

    if (key.name === 'delete') {
      this.currentInput =
        this.currentInput.slice(0, this.cursorIndex) +
        this.currentInput.slice(this.cursorIndex + 1);
      this.render();
      return;
    }

    if (character && !key.name?.startsWith('f')) {
      this.currentInput =
        this.currentInput.slice(0, this.cursorIndex) +
        character +
        this.currentInput.slice(this.cursorIndex);
      this.cursorIndex += character.length;
      this.render();
    }
  }

  private handleRuntimeCommandKeypress(character: string, key: { name?: string }): void {
    if (key.name === 'return') {
      const command = this.runtimeCommand.trim();
      if (command === '/stop') {
        this.printTag('control', 'Stopping current run...', 'warning');
        this.runCancellation?.();
      } else if (command) {
        this.warn(`Unknown runtime command: ${command}`);
      }
      this.runtimeCommand = '';
      this.render();
      return;
    }

    if (key.name === 'up') {
      this.scrollOffset = Math.min(this.scrollOffset + 1, 5000);
      this.render();
      return;
    }

    if (key.name === 'down') {
      this.scrollOffset = Math.max(this.scrollOffset - 1, 0);
      this.render();
      return;
    }

    if (key.name === 'home') {
      this.scrollOffset = 5000;
      this.render();
      return;
    }

    if (key.name === 'end') {
      this.scrollOffset = 0;
      this.render();
      return;
    }

    if (key.name === 'backspace') {
      this.runtimeCommand = this.runtimeCommand.slice(0, -1);
      this.render();
      return;
    }

    if (character) {
      this.runtimeCommand += character;
      this.render();
    }
  }

  private render(): void {
    if (!this.isEnabled) {
      return;
    }

    const rows = stdout.rows || 24;
    const columns = stdout.columns || 100;
    const sidebarWidth = Math.min(36, Math.max(24, Math.floor(columns * 0.3)));
    const mainWidth = Math.max(columns - sidebarWidth - 3, 30);
    const bodyHeight = Math.max(rows - 6, 4);

    const headerLeft = `Universal Agent | ${this.sessionContext.provider}`;
    const headerRight = `${this.sessionContext.sessionLabel}`;
    const sidebarLines = [
      'Status',
      `  ${this.status}`,
      'Approval',
      `  ${this.sessionContext.approvalMode}`,
      'Usage',
      `  ${this.usageSummary}`,
      'Scroll',
      `  offset=${this.scrollOffset}`,
      'Workspace',
      `  ${this.sessionContext.cwd}`,
      'Recent Sessions',
      ...this.sidebarItems.map((item) => `  ${item}`),
      'Tips',
      '  /stop while running',
      '  Up/Down scroll (runtime)',
      '  PgUp/PgDn scroll faster',
    ]
      .flatMap((line) => wrapLine(line, sidebarWidth))
      .slice(0, bodyHeight);
    while (sidebarLines.length < bodyHeight) {
      sidebarLines.push('');
    }

    const allBodyLines = this.buffer
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .flatMap((line) => wrapLine(line, mainWidth));
    const maxOffset = Math.max(allBodyLines.length - bodyHeight, 0);
    const effectiveOffset = Math.min(this.scrollOffset, maxOffset);
    const endIndex = Math.max(allBodyLines.length - effectiveOffset, 0);
    const startIndex = Math.max(endIndex - bodyHeight, 0);
    const bodyLines = allBodyLines.slice(startIndex, endIndex);
    while (bodyLines.length < bodyHeight) {
      bodyLines.push('');
    }

    const footer = this.promptResolver
      ? `${this.currentPrompt}${this.currentInput}`
      : this.runCancellation
      ? `Runtime command: ${this.runtimeCommand}`
      : 'Ready';

    const lines = [
      `${headerLeft.padEnd(mainWidth)} | ${headerRight.slice(0, sidebarWidth)}`,
      `${''.padEnd(mainWidth, '=')} | ${''.padEnd(sidebarWidth, '=')}`,
    ];

    for (let index = 0; index < bodyHeight; index += 1) {
      lines.push(
        `${(bodyLines[index] || '').padEnd(mainWidth)} | ${(sidebarLines[index] || '').padEnd(sidebarWidth)}`
      );
    }

    lines.push(`${''.padEnd(mainWidth, '=')} | ${''.padEnd(sidebarWidth, '=')}`);
    lines.push(footer.slice(0, columns));

    stdout.write(`\u001b[H\u001b[2J${lines.join('\n')}`);
  }

  private truncateBuffer(): void {
    const maxChars = 40000;
    if (this.buffer.length > maxChars) {
      this.buffer = this.buffer.slice(this.buffer.length - maxChars);
    }
  }
}
