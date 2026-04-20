import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface ClaudeDiscoveryResult {
  claudeMd: boolean;
  commands: string[];
  mcpFiles: string[];
  mcpServers: string[];
  settingsFiles: string[];
  skills: string[];
}

export interface ClaudeMcpToolFilter {
  allowed?: string[];
  blocked?: string[];
}

export type ClaudeProjectMcpServerConfig =
  | {
      args?: string[];
      command: string;
      env?: Record<string, string>;
      toolFilter?: ClaudeMcpToolFilter;
      type: 'stdio';
    }
  | {
      headers?: Record<string, string>;
      toolFilter?: ClaudeMcpToolFilter;
      type: 'http';
      url: string;
    }
  | {
      headers?: Record<string, string>;
      toolFilter?: ClaudeMcpToolFilter;
      type: 'sse';
      url: string;
    };

export interface ClaudeProjectMcpLoadResult {
  files: string[];
  servers: Map<string, { config: ClaudeProjectMcpServerConfig; source: string }>;
  warnings: string[];
}

function toDisplayPath(cwd: string, filePath: string): string {
  const userHome = homedir();
  if (filePath.startsWith(userHome)) {
    return filePath.replace(userHome, '~');
  }

  return path.relative(cwd, filePath) || filePath;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, matcher: (filePath: string) => boolean): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (matcher(absolute)) {
        results.push(absolute);
      }
    }
  }

  await walk(root);
  return results;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const headers = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseToolFilter(
  name: string,
  raw: unknown,
  source: string,
  warnings: string[]
): ClaudeMcpToolFilter | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const allowed: string[] = [];
  const blocked: string[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }

    const value = item as Record<string, unknown>;
    if (typeof value.name !== 'string' || typeof value.permission_policy !== 'string') {
      continue;
    }

    if (value.permission_policy === 'always_allow') {
      allowed.push(value.name);
      continue;
    }

    if (value.permission_policy === 'always_deny') {
      blocked.push(value.name);
      continue;
    }

    if (value.permission_policy === 'always_ask') {
      warnings.push(
        `MCP tool policy 'always_ask' for '${name}/${value.name}' in ${source} is not directly representable for OpenAI MCP and will be ignored.`
      );
    }
  }

  if (allowed.length === 0 && blocked.length === 0) {
    return undefined;
  }

  return {
    allowed: allowed.length > 0 ? allowed : undefined,
    blocked: blocked.length > 0 ? blocked : undefined,
  };
}

function normalizeClaudeMcpServer(
  name: string,
  raw: unknown,
  source: string,
  warnings: string[]
): ClaudeProjectMcpServerConfig | null {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push(`Ignored MCP server '${name}' from ${source}: invalid config.`);
    return null;
  }

  const value = raw as Record<string, unknown>;
  const type = typeof value.type === 'string' ? value.type : 'stdio';
  const toolFilter = parseToolFilter(name, value.tools, source, warnings);

  if (type === 'stdio') {
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      warnings.push(`Ignored MCP server '${name}' from ${source}: missing command.`);
      return null;
    }

    return {
      args: Array.isArray(value.args) ? value.args.map(String) : undefined,
      command: value.command,
      env: parseHeaders(value.env),
      toolFilter,
      type: 'stdio',
    };
  }

  if (type === 'http' || type === 'sse') {
    if (typeof value.url !== 'string' || value.url.trim() === '') {
      warnings.push(`Ignored MCP server '${name}' from ${source}: missing url.`);
      return null;
    }

    return {
      headers: parseHeaders(value.headers),
      toolFilter,
      type,
      url: value.url,
    };
  }

  warnings.push(`Ignored MCP server '${name}' from ${source}: unsupported type '${type}'.`);
  return null;
}

export async function loadClaudeProjectMcpServers(cwd: string): Promise<ClaudeProjectMcpLoadResult> {
  const claudeDir = path.join(cwd, '.claude');
  const userClaudeDir = path.join(homedir(), '.claude');
  const candidates = [
    path.join(userClaudeDir, 'settings.json'),
    path.join(userClaudeDir, 'settings.local.json'),
    path.join(cwd, '.mcp.json'),
    path.join(claudeDir, 'settings.json'),
    path.join(claudeDir, 'settings.local.json'),
  ];
  const files = (
    await Promise.all(candidates.map(async (filePath) => ((await exists(filePath)) ? filePath : null)))
  ).filter((filePath): filePath is string => Boolean(filePath));
  const servers = new Map<string, { config: ClaudeProjectMcpServerConfig; source: string }>;
  const warnings: string[] = [];

  for (const filePath of files) {
    const parsed = await readJsonObject(filePath);
    const rawServers = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
    const source = toDisplayPath(cwd, filePath);

    for (const [name, raw] of Object.entries(rawServers)) {
      const config = normalizeClaudeMcpServer(name, raw, source, warnings);
      if (!config) {
        continue;
      }

      servers.set(name, {
        config,
        source,
      });
    }
  }

  return {
    files: files.map((filePath) => toDisplayPath(cwd, filePath)),
    servers,
    warnings,
  };
}

export async function discoverClaudeFeatures(cwd: string): Promise<ClaudeDiscoveryResult> {
  const claudeDir = path.join(cwd, '.claude');
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const userClaudeDir = path.join(homedir(), '.claude');
  const settingsCandidates = [
    path.join(userClaudeDir, 'settings.json'),
    path.join(userClaudeDir, 'settings.local.json'),
    path.join(claudeDir, 'settings.json'),
    path.join(claudeDir, 'settings.local.json'),
  ];
  const settingsFiles = (
    await Promise.all(
      settingsCandidates.map(async (filePath) => ((await exists(filePath)) ? filePath : null))
    )
  ).filter((filePath): filePath is string => Boolean(filePath));
  const commandFiles = await collectFiles(path.join(claudeDir, 'commands'), (filePath) =>
    filePath.endsWith('.md')
  );
  const skillFiles = await collectFiles(path.join(claudeDir, 'skills'), (filePath) =>
    filePath.endsWith(`${path.sep}SKILL.md`) || filePath.endsWith('/SKILL.md')
  );
  const mcp = await loadClaudeProjectMcpServers(cwd);

  return {
    claudeMd: await exists(claudeMdPath),
    commands: commandFiles.map((filePath) => path.relative(cwd, filePath)).sort(),
    mcpFiles: mcp.files,
    mcpServers: Array.from(mcp.servers.keys()).sort(),
    settingsFiles: settingsFiles.map((filePath) => toDisplayPath(cwd, filePath)).sort(),
    skills: skillFiles.map((filePath) => path.relative(cwd, filePath)).sort(),
  };
}
