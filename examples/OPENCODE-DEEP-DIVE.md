# OpenCode Deep Dive

Detailed analysis of OpenCode's architecture and notable implementation patterns.

## Architecture Overview

OpenCode is a **monorepo** with:
- `packages/opencode/` — core engine (session, tools, providers, LSP, permissions)
- `packages/ui/` — React-based TUI (Pierre virtualizer, theming, i18n)
- `sdks/vscode/` — VS Code extension
- `github/` — GitHub Actions integration
- `infra/` — SST infrastructure

The core is ~15k lines of TypeScript in `packages/opencode/src/`.

## Session & Message System

### Message V2 Format

Messages are stored in SQLite (via drizzle ORM). Each message has:
- `id` (ascending identifier with timestamp)
- `role` (user | assistant)
- `sessionID`
- `parentID` (for threading)
- `agent` (which agent generated this)
- `variant` (for A/B conversations)
- `modelID` + `providerID`
- `tokens` (input, output, reasoning, cache read/write)
- `cost`
- `summary` flag (for compaction messages)

Messages have **parts** stored separately:
- `text` — text content
- `tool` — tool call with input, output, metadata, state machine
- `compaction` — compaction marker
- `step` — reasoning step markers

### Session Lifecycle

1. **Create** — new session with optional parentID (for subagents)
2. **Prompt** — user sends message, triggers LLM loop
3. **Process** — SessionProcessor handles streaming, tool calls, errors
4. **Compact** — when context gets full, summarize and truncate
5. **Revert** — undo changes back to any message

### Compaction Strategy

OpenCode's compaction is different from ours:
- It creates a **compaction agent** (separate model/config)
- The compaction prompt asks the model to produce a summary
- The summary becomes a new assistant message with `summary: true`
- All previous messages are NOT deleted — they're still in the DB
- But when building the prompt for the LLM, messages before the summary
  are excluded
- **Prune before compact**: walks backwards through tool outputs, marks
  anything older than 40k tokens as "compacted" (output truncated in prompt)

**Key difference from HAL**: OpenCode keeps all messages in DB but filters
them when building the prompt. HAL actually mutates the message array.

## Tool Implementation Patterns

### Permission-First Design

Every tool call goes through `ctx.ask()`:
```
await ctx.ask({
  permission: "bash",
  patterns: [commandText],
  always: ["*"],
  metadata: {},
})
```

The permission system:
1. Check if pattern is already approved for this session
2. If not, create a pending permission request
3. TUI shows the request to the user
4. User responds: "once", "always", or "reject"
5. "always" approves the pattern for the rest of the session

For bash, commands are parsed with **tree-sitter** to extract:
- The command name (rm, cp, mv, mkdir, etc.)
- Arguments (file paths)
- Whether paths are inside or outside the project directory

### Truncation Strategy

Tool outputs go through `Truncate.output()`:
- Max 2000 lines OR 50KB, whichever hits first
- Direction: "head" for reads, "tail" for bash
- Full output saved to `~/.opencode/data/tool-output/<id>`
- Cleanup: scheduler deletes files older than 7 days
- When truncated, the message tells the model:
  - "Use Task tool to have explore agent process this file" (if available)
  - "Use Grep/Read with offset to explore" (fallback)

This is clever — it doesn't just truncate, it gives the model a strategy for
accessing the full data.

### Bash Tool

The bash tool is **sophisticated**:
1. Parse command with tree-sitter
2. Extract file paths from common commands (cd, rm, cp, mv, mkdir, etc.)
3. Resolve paths to absolute
4. Check if paths are outside project directory → require external dir permission
5. Extract command patterns for permission check
6. Spawn process with proper shell, env, cwd
7. Stream stdout+stderr, update metadata live
8. Handle timeout, abort, kill (entire process tree)
9. Truncate output
10. Return with metadata (exit code, description, truncated output)

### Read Tool

Notable features:
- **Suggests similar files** when file not found (fuzzy matching against dir entries)
- **Binary detection**: checks for null bytes and >30% non-printable characters
- **Image/PDF support**: returns as base64 attachment
- **LSP integration**: touches file to warm the LSP client, tracks read time
- **Instruction injection**: when reading a file, checks for AGENTS.md in parent
  directories and injects those instructions as a `<system-reminder>` tag
- **Max line length**: truncates lines >2000 chars

### Grep Tool (via ripgrep)

- `--hidden --no-messages` for consistent behavior
- Sorts results by file modification time (most recently modified first!)
- Limits to 100 matches
- Truncates lines to 2000 chars
- Returns structured output with match count

### Glob/Find Tool

- Uses ripgrep's file listing mode
- Limits to 100 files
- Sorts by modification time
- Simple pattern-based file search

### List Tool

- Uses ripgrep for file enumeration
- Builds a tree-structured view (indented dirs/files)
- Ignores common noise dirs (node_modules, __pycache__, .git, dist, etc.)
- Limits to 100 files

## Snapshot System

The snapshot system is remarkably clever:

1. Creates a **separate git repository** in `~/.opencode/data/snapshot/<project-id>/`
2. This is NOT the project's git repo — it's a shadow repo
3. Before tool calls: `git add . && git write-tree` to capture current state
4. After tool calls: `git diff` between the tree and working directory
5. On revert: `git read-tree <hash> && git checkout-index -a -f`

This means:
- Snapshots don't pollute the project's git history
- Works even if the project isn't a git repo (well, it checks for git)
- Can diff any two points in time
- Can restore any snapshot
- Scheduler prunes old snapshots (7 days)

## LSP Integration

Full Language Server Protocol client:
- Spawns LSP servers per file type (TypeScript, Python, Go, etc.)
- Configurable via config file
- After file edits, "touches" the file with the LSP server
- Gets diagnostics (errors, warnings) back
- Exposes: hover, go-to-definition, references, implementation, call hierarchy
- Used by the edit tool to report errors after making changes

## Notable Patterns

### Ascending Identifiers

`Identifier.ascending()` generates IDs that are:
- Timestamp-based (sortable by creation time)
- Collision-resistant
- Prefixed by type (session_, message_, part_, etc.)

### Instance State

`Instance.state()` is a factory for per-project singleton state:
- Lazy initialized
- Has cleanup function for shutdown
- Tied to the project instance lifecycle

### Event Bus

Full pub/sub event bus for decoupled communication:
- Permission events
- File watcher events
- Session events
- Message events
- LSP events

### Configuration

Supports:
- Project-level config (`.opencode/config.yaml`)
- Global config (`~/.opencode/config.yaml`)
- Environment variables for overrides
- Feature flags system

## What's Worth Stealing vs Building From Scratch

### Steal the pattern:
1. **Truncation with strategy hints** — don't just truncate, tell the model how
   to get the full data
2. **Sort results by mtime** — most recently modified files are most relevant
3. **Fuzzy file suggestions** on not-found errors
4. **Shadow git repo for snapshots** — elegant, doesn't pollute project
5. **Prune before compact** — reduce noise before summarizing

### Build from scratch (simpler):
1. **Permissions** — we can do something much simpler (just confirm dangerous ops)
2. **LSP** — start with "run tsc --noEmit" instead of full LSP client
3. **Event bus** — overkill for our architecture
4. **Database** — JSON file is fine for single-user
