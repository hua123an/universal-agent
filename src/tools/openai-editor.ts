import fs from 'node:fs/promises';
import path from 'node:path';
import { applyDiff, type Editor, type EditorInvocationContext } from '@openai/agents';
import type { ApplyPatchOperation } from '@openai/agents';
import { resolveWorkspacePath, toDisplayPath } from '../utils/path.js';

export class WorkspaceEditor implements Editor {
  constructor(private readonly workspaceRoot: string) {}

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
    _context?: EditorInvocationContext
  ) {
    const absolute = resolveWorkspacePath(this.workspaceRoot, operation.path);
    const content = applyDiff('', operation.diff, 'create');
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    return {
      output: `Created ${toDisplayPath(this.workspaceRoot, absolute)}`,
      status: 'completed' as const,
    };
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
    _context?: EditorInvocationContext
  ) {
    const absolute = resolveWorkspacePath(this.workspaceRoot, operation.path);
    const current = await fs.readFile(absolute, 'utf8');
    const next = applyDiff(current, operation.diff);
    await fs.writeFile(absolute, next, 'utf8');
    return {
      output: `Updated ${toDisplayPath(this.workspaceRoot, absolute)}`,
      status: 'completed' as const,
    };
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
    _context?: EditorInvocationContext
  ) {
    const absolute = resolveWorkspacePath(this.workspaceRoot, operation.path);
    await fs.unlink(absolute);
    return {
      output: `Deleted ${toDisplayPath(this.workspaceRoot, absolute)}`,
      status: 'completed' as const,
    };
  }
}
