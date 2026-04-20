# Universal Agent

`universal-agent` is a small TypeScript CLI that combines:

- `@anthropic-ai/claude-agent-sdk` for Claude Code-style code execution in a real workspace
- `@openai/agents` for planning, review, structured outputs, and a provider-neutral agent runtime

The default `hybrid` mode uses both:

- OpenAI plans the task with read-only workspace tools
- Anthropic executes the code changes with Claude Agent SDK
- OpenAI reviews the resulting workspace state for risks and gaps

## Why this split

- Anthropic is strongest here as the coding executor because the Agent SDK exposes the Claude Code tool loop directly
- OpenAI is strongest here for structured planning and post-run review because the Agents SDK makes that small and explicit

## Features

- `provider=anthropic|openai|hybrid`
- `--chat` interactive multi-turn mode
- `--tui` minimal full-screen terminal UI for chat mode
- Chat mode streams assistant output instead of waiting for the whole turn to finish
- Shared local session IDs for resume
- OpenAI-side local workspace tools:
  - `read_file`
  - `glob_files`
  - `grep_files`
  - `describe_workspace`
  - `shell`
  - `apply_patch`
- OpenAI coding, planner, and reviewer runs load compatible MCP servers from project and user Claude config
- Anthropic-side interactive approvals via `canUseTool`
- Prompt or auto approval modes
- Persistent approval rules for shell/write actions
- Per-run and per-session usage tracking
- Local session metadata under `~/.universal-agent` by default

## Install

```bash
npm install
```

## Configure

Copy `.env.example` values into your shell or environment.

Required for OpenAI mode:

```bash
export OPENAI_API_KEY=...
```

Required for Anthropic mode:

```bash
export ANTHROPIC_API_KEY=...
```

Required for hybrid mode: both.

## Develop

Run directly with `tsx`:

```bash
npm run dev -- --provider hybrid "Audit this repository and fix the biggest issue"
npm run dev -- --chat --provider hybrid
npm run dev -- --chat --tui --provider hybrid
```

Build the CLI:

```bash
npm run build
```

Run the built CLI:

```bash
node dist/index.js --provider anthropic "Implement tests for auth.ts"
node dist/index.js --chat --provider anthropic
node dist/index.js --chat --tui --provider hybrid
```

## Usage

```bash
universal-agent [options] <prompt>
universal-agent --chat [options] [initial-prompt]
universal-agent sessions [query]
universal-agent history [limit]
universal-agent transcript [source] [limit]
universal-agent export [--json|--markdown|--html] [path]
universal-agent mcp
```

Examples:

```bash
node dist/index.js --provider hybrid "Refactor the auth flow and verify it still works"
node dist/index.js --provider openai --approval prompt "Search for dead code and remove it"
node dist/index.js --chat --provider hybrid
node dist/index.js sessions
node dist/index.js history --resume <session-id> 20
node dist/index.js export --resume <session-id> --html exports/session.html
node dist/index.js --provider anthropic --resume <session-id> "Continue from where you left off"
```

Options:

- `--chat`
- `--tui`
- `--provider <anthropic|openai|hybrid>`
- `--approval <auto|prompt>`
- `--cwd <path>`
- `--resume <session-id>`
- `--max-turns <number>`

## Top-level commands

You can inspect local state without entering chat mode:

```bash
node dist/index.js sessions
node dist/index.js sessions auth
node dist/index.js history --resume <session-id> 20
node dist/index.js transcript --resume <session-id> all 100
node dist/index.js export --resume <session-id> --markdown
node dist/index.js mcp
```

## Chat mode

Interactive chat mode keeps using the same app session across turns.

Start a fresh chat:

```bash
node dist/index.js --chat --provider hybrid
```

Start chat with an initial prompt:

```bash
node dist/index.js --chat --provider anthropic "Inspect this repo and tell me where to start"
```

Resume an existing chat:

```bash
node dist/index.js --chat --resume <session-id>
```

Available chat commands:

- `/help`
- `/session`
- `/sessions [query]`
- `/use [id|n|query]`
- `/rename [title]`
- `/export [--json|--markdown|--html] [path]`
- `/history [limit]`
- `/transcript [source] [limit]`
- `/commands`
- `/skills`
- `/mcp`
- `/stop`
- `/clear`
- `/new`
- `/delete [target]`
- `/exit`
- `/quit`

Behavior notes:

- Direct `anthropic` and `openai` chat runs stream assistant text as it is generated
- `hybrid` chat runs show planner/reviewer progress lines and stream the Anthropic executor output
- OpenAI chat runs now print live tool events such as calls, approvals, and outputs
- Anthropic chat runs now print live tool progress and tool summaries when available from the SDK
- Unknown non-built-in slash commands are forwarded in `anthropic` mode and bypass hybrid planning in `hybrid` mode so Claude custom commands can run directly
- OpenAI coding, planner, and reviewer runs attempt to connect compatible MCP servers from:
Sources checked: `~/.claude/settings.json`, `~/.claude/settings.local.json`, `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`
- Supported MCP transports in OpenAI mode: `stdio`, `http`, `sse`
- Basic MCP tool allow/block filters are derived from Claude `tools` policies when possible
- `/clear` clears history in the current app session and attempts to delete the linked Anthropic transcript too
- `/new` creates a brand new app session in the same workspace/provider
- `/rename` stores a local session title and also renames the Anthropic transcript when one exists
- `/export` supports JSON, Markdown, and HTML snapshots of the current session
- `/history` shows a concise recent conversation view using the primary transcript for the current session
- `/transcript` shows transcript entries from `anthropic`, `main`, `planner`, `reviewer`, or `all`; `all` is now merged and sorted as a single timeline when timestamps are available
- `/commands`, `/skills`, and `/mcp` inspect project-local Claude surfaces such as `.claude/commands`, `.claude/skills`, `CLAUDE.md`, and `.mcp.json`
- `/delete` removes the selected app session metadata and local OpenAI lane files; if an Anthropic transcript exists, the CLI also attempts to delete it
- `/sessions` lists the most recent saved sessions for the current workspace/provider and can filter by text
- `/use` accepts a session id, a number from `/sessions`, or a text query that matches recent sessions
- Session listings now surface degraded and delegated runs explicitly, for example `openai via anthropic [degraded]`
- Approval prompts now support: allow once, allow for session, always allow in workspace, deny once, always deny in workspace
- Each completed run updates session-level usage totals; Anthropic cost is recorded when available from the SDK
- Press `Ctrl+C` during a run to cancel the current turn
- In `--tui` mode you can also type `/stop` while a run is active to cancel that turn
- Chat output uses ANSI color labels when running in a TTY that supports color

Examples:

- `/export --markdown`
- `/export --html exports/session.html`
- `/history 20`
- `/transcript anthropic 50`
- `/transcript all 100`
- `/commands`
- `/mcp`

## TUI mode

Use the minimal terminal UI for chat sessions:

```bash
node dist/index.js --chat --tui --provider hybrid
```

The TUI shows:

- session/provider header
- live status
- usage summary
- recent session sidebar
- scrollback transcript
- bottom input prompt

The TUI now uses one raw-mode input loop for:

- normal chat input
- approval prompts
- selection prompts
- runtime stop commands

While a run is active in the TUI:

- type `/stop` to cancel the turn
- use `Up` / `Down` to scroll one line
- use `PageUp` / `PageDown` to scroll faster
- use `Home` / `End` to jump through the scrollback

## Session model

The app stores its own session metadata in:

```text
~/.universal-agent/
  sessions/
  items/
```

- The app session ID is the single thing you resume with
- OpenAI lane sessions are derived from that app session ID
- Anthropic session IDs are captured and stored in app metadata

## Project layout

```text
src/
  index.ts                 CLI entrypoint
  config.ts                env and model config
  providers/
    anthropic.ts           Claude Agent SDK execution
    openai.ts              OpenAI coding, planner, reviewer agents
    hybrid.ts              OpenAI plan + Anthropic execute + OpenAI review
  sessions/
    metadata-store.ts      app-level session metadata
    file-session.ts        OpenAI file-backed session store
  tools/
    workspace.ts           read/glob/grep helpers over the workspace
    openai-shell.ts        local shell implementation for OpenAI shellTool
    openai-editor.ts       local editor implementation for OpenAI applyPatchTool
```

## Notes

- OpenAI tracing is disabled by default in this implementation to keep the CLI simple
- Anthropic still uses its own underlying Claude Code session persistence; this app only keeps the bridge metadata needed to resume consistently
- `hybrid` is the intended default because it makes each SDK do the thing it is best at in this implementation
