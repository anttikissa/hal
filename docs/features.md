# Hal — Complete Feature Specification

A terminal-native AI coding agent with multi-tab TUI, persistent sessions, and file-backed IPC. Built with Bun + TypeScript, no build step. ~8.3K LOC non-test runtime code.

This document is a blueprint: with it, a coding agent could rebuild a similarly-featured system from scratch in a well-thought-out order.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  CLI Process (TUI client)                           │
│  - Prompt editor, tab bar, message rendering        │
│  - Reads events, sends commands via IPC bus         │
└──────────────┬──────────────────────────────────────┘
               │  file-backed IPC (ASONL append-only logs)
┌──────────────▼──────────────────────────────────────┐
│  Runtime Process (owner/host)                       │
│  - Agent loop: prompt → API → tool calls → repeat   │
│  - Session management, tool execution               │
│  - Provider adapters (Anthropic, OpenAI)            │
└─────────────────────────────────────────────────────┘
```

A single OS process runs both: `main.ts` elects an owner (via pidfile), then starts the runtime and CLI in the same process. Multiple CLI instances can connect to the same runtime. If the owner dies, a new one is elected.

### State layout

```
$HAL_DIR/                     # ~/.hal by default
  auth.ason                   # API keys (gitignored)
  config.ason                 # user config
  SYSTEM.md                   # system prompt template
  AGENTS.md                   # project-level agent instructions
  state/
    ipc/
      commands.asonl          # client → host command stream
      events.asonl            # host → client event stream
      state.ason              # runtime state snapshot
      owner.pid               # pidfile for owner election
    sessions/
      <id>/
        session.ason          # session metadata
        history.asonl         # conversation log (append-only)
        history-*.asonl       # rotated logs from compaction
        blobs/
          <blobId>.ason       # tool call/result snapshots, images
        eval/
          <ts>-<n>.ts         # eval tool scripts (audit trail)
```

---

## Build Phases

Recommended implementation order. Each phase builds on the previous.

---

### Phase 1: Foundation

**Files:** `utils/ason.ts`, `state.ts`, `config.ts`, `runtime/auth.ts`, `utils/live-file.ts`, `utils/read-file.ts`

#### 1.1 ASON — Serialization Format

A JSON superset that supports:
- Unquoted keys: `{foo: 1}` is valid
- Single-quoted strings: `'hello'`
- Trailing commas: `{a: 1, b: 2,}`
- Comments: `// line` and `/* block */`
- Multiline strings: backtick-delimited, like JS template literals (no interpolation)
- `undefined` as a value
- `Infinity`, `-Infinity`, `NaN`
- Dates: `d"2024-01-15T10:30:00.000Z"` → `Date` object
- Binary: `b"base64data"` → `Buffer`
- RegExp: `r"pattern"flags`
- BigInt: `123n`

Stringify produces ASON with unquoted keys, double-quoted string values, date/buffer/regex/bigint literals. Pretty-print with configurable indent.

**ASONL**: one ASON value per line, no separators. Parse with `ason.parseAll(text)`. Used for all append-only logs (history, IPC events/commands).

This module is battle-tested and can be reused as-is (~400 LOC).

#### 1.2 State Directories

- `state.ts` — exports paths: `HAL_DIR`, `STATE_DIR`, `LAUNCH_CWD`
- Helper functions: `sessionDir(id)`, `blobsDir(id)`, `ensureDir(path)`
- Session IDs: `MM-XXX` format — two-digit month + 3-char random suffix (e.g. `03-a4f`)

#### 1.3 Config

- `config.ason` — live-reloading config file
- Fields: `defaultModel`, `fastModel`, `permissions` (`yolo`|`ask-writes`|`ask-all`), `eval` (boolean), `debug` (boolean)
- Uses `liveFile()` — a utility that reads+parses a file, caches it, and re-reads on `mtime` change

#### 1.4 Auth

- `auth.ason` — stores API keys per provider: `{anthropic: {accessToken: "sk-..."}, openai: {accessToken: "sk-..."}}`
- `getAuth(provider)` returns `{accessToken}`, falls back to env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
- Live-reloading via `liveFile()`

#### 1.5 Live File Utility

`liveFile<T>(path, opts)` — returns a proxy object that:
- Reads and parses the file on first access
- Caches the result, re-reads only when `mtime` changes (checked at most once per 2s)
- Merges with `opts.defaults`
- Works with ASON format

#### 1.6 Read File Cache

`readFiles` — a thin caching layer over `fs.readFileSync`/`readFile`:
- `readTextSync(path, caller)` / `readText(path, caller)`
- `readBytesSync(path, caller)` / `readBytes(path, caller)`
- Caches by path+mtime, auto-invalidates on file change
- `caller` param for debugging cache behavior

---

### Phase 2: IPC Bus

**Files:** `ipc.ts`, `protocol.ts`

File-backed IPC between runtime (host) and CLI clients. No sockets, no daemons — just append-only ASONL files and a pidfile.

#### 2.1 Protocol Types

**Commands** (client → host):
- `prompt` — user message with text
- `pause` — abort current generation
- `continue` — resume interrupted generation
- `open` — create new session (or resume existing by id)
- `close` — close session tab
- `fork` — fork current session
- `reset` — clear conversation
- `compact` — manually compact context
- `model` — switch model (or list available)
- `topic` — set session topic
- `cd` — change working directory
- `resume` — reopen a closed session
- `respond` — answer to an `ask` tool question
- `steer` — inject a steering prompt mid-generation (not currently active)

**Events** (host → clients):
- `line` — info/warn/error/tool/meta messages with level
- `chunk` — streaming text (`assistant` or `thinking` channel)
- `status` — busy/paused state, context usage, activity text
- `sessions` — full session list broadcast
- `command` — command lifecycle (queued/started/done/failed)
- `prompt` — echo of user prompt
- `tool` — tool execution lifecycle (running/streaming/done/error)
- `question` — ask tool question to user
- `answer` — user's answer to question

**RuntimeState** — snapshot written to `state.ason`:
- `hostPid`, `hostId`, active/busy sessions, `eventsOffset`, `handoff` info, `pendingQuestions`

Each command/event has an `id`, `createdAt` timestamp, and `sessionId`.

#### 2.2 IPC Bus Implementation

- **Commands file** (`commands.asonl`): clients append commands, host tails
- **Events file** (`events.asonl`): host appends events, clients tail
- **State file** (`state.ason`): host writes full state snapshot periodically
- **Owner pidfile** (`owner.pid`): exclusive-create (`open('wx')`) for leader election

**Tailing**: poll-based with `fs.stat()` — check mtime/size, read new bytes from last offset. No `fs.watch` (unreliable). Poll interval: 50ms for clients reading events, 100ms for host reading commands.

**Client reading events**: maintains a byte offset into `events.asonl`. On each poll, reads new bytes, parses ASONL lines, dispatches to callbacks.

**Lifecycle**:
1. On startup, try to create `owner.pid` exclusively
2. If success → become host, start runtime
3. If fail → read existing pid, check if alive (`kill(pid, 0)`)
4. If dead → remove stale pidfile, retry
5. If alive → run as client only

**Handoff**: when host restarts (exit code 100), it writes a `handoff` object to `state.ason` with `mode: 'continue'` and active session list. New host reads this within a 10s window and resumes those sessions.

#### 2.3 Event Publishing

Host maintains an in-memory ring buffer of recent events. On publish:
1. Serialize event to ASONL
2. Append to `events.asonl`
3. Update in-memory offset

Clients skip events older than their connect time (use `eventsOffset` from state).

---

### Phase 3: Session Persistence

**Files:** `session/session.ts`, `session/history.ts`, `session/history-fork.ts`, `session/blob.ts`, `session/prune.ts`, `session/attachments.ts`

#### 3.1 Session Lifecycle

- `createSession(workingDir)` — generates ID (`MM-XXX`), writes `session.ason` with metadata
- `loadSessionInfo(id)` — reads `session.ason`, returns `SessionInfo`
- `listSessionIds()` — scans `state/sessions/` directory
- `rotateLog(id)` — renames `history.asonl` → `history-NNNN.asonl`, creates fresh log. Used by `/compact` and `/reset`

**SessionInfo fields**: `id`, `topic`, `model`, `log` (current log filename), `workingDir`, `createdAt`, `updatedAt`, `closedAt`, `lastPrompt`, `context` (usage).

#### 3.2 History (Append-Only Log)

The conversation log (`history.asonl`) stores heterogeneous ASONL entries:

**Entry types:**
- `{role: 'user', content: string | ContentBlock[], ts}` — user message
- `{role: 'assistant', text, thinking, toolCalls, usage, ts}` — assistant response
- `{role: 'tool_result', toolId, content, blobId, ts}` — tool execution result
- `{type: 'forked_from', parent, ts}` — fork chain link (first entry)
- `{type: 'compact', ts}` — compaction marker (history before this is in rotated log)
- `{type: 'session', action, ...}` — session events (model-change, cd, etc.)
- `{type: 'info', text, level, ts}` — info/meta messages
- `{type: 'tool', toolId, name, phase, ...}` — tool lifecycle events

**Key operations:**
- `readHistory(id)` — reads current log file, returns array of entries
- `appendHistory(id, entries)` — appends entries to log
- `loadApiMessages(id)` — converts history entries to API-format messages (user/assistant with tool_use/tool_result). This is the core function that builds the conversation for the model.
- `writeUserEntry(id, content)` — writes user message entry
- `writeToolResultEntry(id, toolId, content, blobMap)` — writes tool result with blob reference
- `ensureModelEvent(id, model)` — records model change if different from last
- `buildCompactionContext(id, msgs)` — builds a summary context block for compaction (includes all user messages and abbreviated assistant responses)
- `detectInterruptedTools(msgs)` — finds tool_use blocks without matching tool_result (from crashes/aborts)

**loadApiMessages** algorithm:
1. Follow fork chain to collect all history entries
2. Find the last `compact` marker — only include entries after it
3. Apply pruning (Phase 8) to manage context size
4. Convert entries to API message format:
   - User entries → `{role: 'user', content}`
   - Assistant entries → `{role: 'assistant', content: [text_block, ...tool_use_blocks]}`
   - Tool results → paired into assistant's tool_use with `{role: 'user', content: [tool_result_blocks]}`
5. Include `[system]` info messages as user messages
6. Handle tool results that span multiple entries (group by preceding assistant message)

#### 3.3 Fork Chains

- `forkSession(parentId)` — creates new session, writes `{type: 'forked_from', parent: parentId}` as first entry
- `readHistoryWithForks(id)` — recursively follows fork chain, concatenates parent history + child history
- `readBlobFromForkChain(id, blobId, readFn)` — walks up fork chain to find blob (child blobs shadow parent)

Fork semantics: child inherits parent's full conversation history at fork time. Both diverge independently after that.

#### 3.4 Blob Store

Content-addressed storage under `sessions/<id>/blobs/`:
- `makeId(sessionId)` — time-offset-based ID: `XXXXXX-YYY` (base36 offset from session start + random suffix)
- `write(sessionId, blobId, data)` — writes ASON file
- `read(sessionId, blobId)` — reads with fork chain fallback
- `updateInput(sessionId, blobId, input, originalInput)` — updates tool call input in blob (for edit tool path resolution)

Used to store: tool call details (name, input, output), images (base64), large results.

#### 3.5 Attachments

Resolves `[file.png]` and `[file.txt]` bracket references in user input:
- Image files (png/jpg/gif/webp) → base64-encoded image content blocks for API, blob reference for history log
- Text files (only from `/tmp/hal/`) → inline text content for API, path reference for log
- Returns `{apiContent, logContent}` — API gets full data, history log gets lightweight references

---

### Phase 4: Provider Adapters

**Files:** `providers/anthropic.ts`, `providers/openai.ts`, `providers/provider.ts`

#### 4.1 Provider Interface

```typescript
interface GenerateOptions {
  model: string
  system: string
  messages: ApiMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onChunk?: (event: StreamEvent) => void
  thinkingBudget?: number
}

interface GenerateResult {
  text: string
  thinking: string
  toolCalls: ToolCall[]
  usage: { input: number; output: number; cacheRead?: number; cacheCreation?: number }
  stopReason: string
}
```

#### 4.2 Anthropic Provider

- Streaming via SSE to `https://api.anthropic.com/v1/messages`
- Headers: `x-api-key`, `anthropic-version: 2023-06-01`
- Extended thinking support: `thinking: {type: 'enabled', budget_tokens: N}` — budget scales with model context (e.g. 32K for Opus)
- Prompt caching: marks system prompt and early conversation turns with `cache_control: {type: 'ephemeral'}` to reduce costs. Strategy: cache system prompt + up to 4 early turns.
- Streaming events: `message_start`, `content_block_start`, `content_block_delta` (text_delta, thinking_delta, input_json_delta), `content_block_stop`, `message_delta`, `message_stop`
- Tool use: `tool_use` content blocks with `id`, `name`, `input`
- Tool results: `tool_result` content blocks paired by `tool_use_id`
- Server-sent tool: `web_search` — Anthropic executes the search server-side, returns results inline

#### 4.3 OpenAI Provider

- Streaming via SSE to `https://api.openai.com/v1/chat/completions`
- Maps Anthropic-style messages to OpenAI format (system → system message, tool_use → function calls, tool_result → function role messages)
- Supports `gpt-5.x` family and `gpt-5.x-codex` variants
- Tool calls via `function` type tools, streamed as deltas
- Reasoning/thinking support via `reasoning` message content (mapped to thinking channel)

#### 4.4 Model Registry

- Aliases: short names → full `provider/model-id` (e.g. `opus` → `anthropic/claude-opus-4-6`)
- Pattern aliases: `opus-X` → `anthropic/claude-opus-X`, `sonnet-X`, `haiku-X`, `gpt-X.Y`
- Display names: `anthropic/claude-opus-4-6` → `Opus 4.6` (for UI)
- Fast model resolution: picks cheapest available model for background tasks (Haiku, GPT-4o-mini)
- `/model` command lists all available models with auth status

---

### Phase 5: Runtime (Owner Process)

**Files:** `runtime/runtime.ts`, `runtime/commands.ts`, `runtime/system-prompt.ts`, `runtime/agent-loop.ts`

#### 5.1 Owner Election & Startup

1. Try exclusive-create `owner.pid`
2. Write own PID
3. Check for handoff state (another instance that exited with code 100)
4. If handoff within 10s window → resume those sessions
5. Otherwise → create initial session
6. Start polling `commands.asonl` for client commands

**Restart loop**: the `run` shell script wraps the process. Exit code 100 = restart (used for self-updates). The script re-execs the same command.

#### 5.2 System Prompt

`SYSTEM.md` is preprocessed before sending to the model:
- Variable substitution: `${model}`, `${date}`, `${hal_dir}`, `${session_dir}`, `${cwd}`, `${eval}`
- Conditional blocks: `::: if model="glob*"` ... `:::` — include content only for matching models
- HTML comment stripping
- Consecutive blank line collapsing

**AGENTS.md chain**: walks from git root down to session's `workingDir`, collecting all `AGENTS.md` (or `CLAUDE.md` fallback) files. Concatenated after SYSTEM.md. This gives per-project instructions.

System prompt is reloaded on every generation (so edits take effect immediately).

#### 5.3 Agent Loop

The core generation cycle for a session:

```
1. Build system prompt (SYSTEM.md + AGENTS.md chain)
2. Load API messages from history
3. Call provider.generate() with streaming
4. Stream chunks to clients (text + thinking channels)
5. If response contains tool calls:
   a. For each tool call (parallel where possible):
      - Emit tool-running event
      - Execute tool
      - Emit tool-done event with output
      - Write tool result to history
   b. Append assistant message + tool results to history
   c. Go to step 2 (loop)
6. If no tool calls (text-only response):
   - Append assistant message to history
   - Done
```

**Parallel tool execution**: tools within a single response are executed concurrently (Promise.all), unless one is the `ask` tool (which blocks for user input).

**Abort handling**: each generation has an `AbortController`. `/pause` aborts it. On abort:
- Current streaming stops
- Partial assistant message is saved to history
- Interrupted tool calls (tool_use without tool_result) are detected and auto-resolved on next prompt with `[interrupted — skipped]`

**Activity indicator**: during generation, broadcasts `status` events with `activity` text showing what's happening (e.g. tool name being executed, "thinking...", streaming token count).

**Context tracking**: after each API response, records `{used, max}` token counts from usage info. Broadcasts to clients for display.

#### 5.4 Autocompact

When context usage reaches 70% of max:
1. Build compaction context (summary of all user messages + abbreviated assistant responses)
2. Rotate the log file
3. Write compaction marker + summary as the new history
4. Continue with reduced context

Manual `/compact` does the same thing on demand.

#### 5.5 Command Handling

Each command type has a handler in `commands.ts`:

- **prompt**: resolve attachments, write user entry, check for autocompact, build API messages, start generation
- **pause**: abort controller + resolve pending ask questions
- **continue**: detect interrupted tools, auto-resolve them, resume generation
- **open**: create new session or resume existing
- **fork**: create child session with fork chain link, insert after parent in tab order
- **close**: abort if busy, mark closed, remove from active sessions. If last session → exit
- **reset**: rotate log, write system message about reset
- **compact**: build context summary, rotate log, write summary
- **model**: resolve alias, record model change event, broadcast
- **topic**: set session topic
- **cd**: change session working directory, record event, show AGENTS.md files found
- **resume**: list closed sessions or reopen specific one
- **respond**: resolve pending `ask` tool question with user's answer

#### 5.6 Session Greeting

New sessions get a greeting: the assistant's first message. Written directly to history (not via API) as a pre-canned welcome.

---

### Phase 6: Tools

**Files:** `runtime/tools.ts`, `runtime/eval-tool.ts`, `tools/bash.ts`, `tools/read.ts`, `tools/write.ts`, `tools/edit.ts`, `tools/grep.ts`, `tools/read-blob.ts`, `tools/file-utils.ts`, `tools/tool.ts`

#### 6.1 Tool Framework

Each tool is a module with:
- `definition` — JSON Schema for the tool (name, description, input_schema)
- `execute(input, ctx, onChunk?)` — runs the tool, returns string or content blocks
- `argsPreview(input)` — short preview string for UI display

`ToolContext` provides: `cwd` (session working directory), `sessionId`, `signal` (abort), `contextLines`, `truncate` helper.

**Output handling**: tool output is truncated at 50KB. Home directory paths are shortened to `~`.

**Required param validation**: checks `input_schema.required` before execution, returns error if missing.

#### 6.2 bash

- Runs shell commands via `Bun.spawn` with `['bash', '-c', command]`
- Working directory: session's `workingDir`
- Timeout: 120 seconds
- Streaming: stdout/stderr chunks are streamed to client via `onChunk` callback
- Output: combines stdout + stderr, truncates
- Exit code: appended if non-zero (`\n[exit N]`)
- Abort: kills process on signal abort
- Environment: inherits process env + `LANG=en_US.UTF-8`

#### 6.3 read

- Reads file content with hashline format: `LINE:HASH content`
- Each line gets a prefix with line number and 3-char hash (first 3 of hex SHA-256 of line content)
- Optional `start`/`end` params for line range reads
- The hash is used by the `edit` tool to verify line content hasn't changed
- Preview: shows filename + line range

#### 6.4 write

- Creates or overwrites a file with full content
- Creates parent directories automatically (`mkdirSync recursive`)
- Content parameter is the raw file content (no hashline prefixes)
- Returns byte count written

#### 6.5 edit

- Surgical file editing using hashline references from `read`
- Two operations:
  - **replace**: replace lines from `start_ref` to `end_ref` (inclusive) with `new_content`. Same ref for single line. Empty content to delete lines.
  - **insert**: insert `new_content` after `after_ref`. Use `"0:000"` for beginning of file.
- References are `LINE:HASH` format — line number + hash verified against current file content
- If hash doesn't match → error telling model to re-read the file
- A trailing newline in `new_content` is stripped (each line already has one in the file)
- Returns the changed lines in hashline format (with a few lines of context)

#### 6.6 grep

- Uses `ripgrep` (`rg`) under the hood
- Params: `pattern` (regex), `path` (directory/file), `include` (glob filter)
- Returns matching lines with file paths and line numbers
- Truncates output

#### 6.7 glob

- Uses `rg --files` with `--glob` pattern
- Returns matching file paths sorted by modification time
- Params: `pattern`, `path` (search directory)

#### 6.8 ls

- Directory tree listing, recursive to configurable depth (default 3)
- Ignores: `node_modules`, `.git`, `dist`, `build`, `.next`, `__pycache__`, `.cache`, `coverage`, `target`
- Truncates at 500 entries

#### 6.9 ask

- Pauses generation, sends a `question` event to the client
- Client shows the question and waits for user input
- User's response is sent back as a `respond` command
- The tool returns the user's answer text
- If generation is paused/aborted while waiting, returns empty string

#### 6.10 eval

- Executes TypeScript code inside the Hal process itself
- Code has access to `ctx` object: `{sessionId, halDir, stateDir, cwd, runtime}`
- Imports with `~src/` prefix resolve to Hal's own source
- Scripts are persisted in `sessions/<id>/eval/` for audit
- Implementation: extracts import lines to module top-level, wraps body in `export default async (ctx) => { ... }`, writes to file, dynamic `import()`, calls default export
- Only available when `config.eval` is true

#### 6.11 read_blob

- Reads a stored blob by ID from the session's blob store
- Walks fork chain to find blobs from parent sessions
- Used to inspect tool call details, images, or old file contents

#### 6.12 web_search

- Anthropic's server-side web search tool (type `web_search_20250305`)
- Not executed locally — sent as a tool definition, Anthropic handles it
- Limited to 5 uses per response

---

### Phase 7: CLI / TUI

**Files:** `cli/app.ts`, `cli/render.ts`, `cli/prompt.ts`, `cli/completions.ts`, `cli/input.ts`, `cli/clipboard.ts`, `cli/test-driver.ts`

#### 7.1 Application Shell

- Single fullscreen terminal application using raw mode
- Alternate screen buffer (`\x1b[?1049h`)
- Mouse tracking enabled (`\x1b[?1003h\x1b[?1006h`)
- Synchronized output for flicker-free rendering (`\x1b[?2026h` ... `\x1b[?2026l`)

**Layout** (top to bottom):
1. **Tab bar** — one line showing session tabs with topic/model/context
2. **Message area** — scrollable conversation history
3. **Status line** — model name, context usage, activity indicator
4. **Prompt area** — multi-line input editor (grows upward)

#### 7.2 Prompt Editor

Full-featured multi-line text editor:

**Text editing:**
- Character insertion at cursor
- Backspace / Delete (Ctrl-D) — character and selection deletion
- Word deletion: Ctrl-W (backward), Alt-D (forward)
- Line operations: Ctrl-U (delete to start), Ctrl-K (delete to end), Ctrl-A (home), Ctrl-E (end)
- Enter: newline when Shift-Enter, Option-Enter, or cursor not at end. Submit when Enter at end of input.
- Alt-Enter: always inserts newline

**Cursor movement:**
- Arrow keys: left/right by character, up/down by line
- Alt-Left/Right: word-by-word movement (skipping word boundaries)
- Alt-Up/Down: move to start/end of input
- Ctrl-A / Ctrl-E: line start/end

**Selection:**
- Shift+Arrow: extend selection by character
- Shift+Alt+Arrow: extend selection by word
- Ctrl-Shift-A / Ctrl-Shift-E: select to line start/end
- Shift-Alt-Up/Down: select to start/end of input
- Selected text is highlighted (reverse video)
- Typing with active selection replaces it
- Backspace/Delete with selection removes selected text

**History:**
- Up/Down arrows (when at first/last line) navigate prompt history
- History is per-session, loaded from conversation log
- History navigation preserves current draft

**Paste:**
- Ctrl-V / Cmd-V: reads clipboard
- Bracketed paste mode (`\x1b[200~` ... `\x1b[201~`): handles multi-line paste
- Large pastes (>5 newlines): auto-saved to `/tmp/hal/paste/NNNN.txt`, inserted as `[path]` reference
- Image paste: if clipboard has no text, probes for PNG image via AppleScript (`osascript`), inserts `[image:N]` placeholder, resolves asynchronously to `[/tmp/hal/images/XXX.png]`
- Image drag-and-drop: single-line path ending in image extension → wrapped in brackets

**Tab completion:**
- Tab key triggers completion at cursor
- Completes: `/commands`, `model` names, file paths
- File path completion: recognizes paths after spaces or at line start, expands with `rg --files`
- Shows completion inline, Tab again to cycle, Enter/Space to accept
- Completable items: slash commands (`/pause`, `/model`, etc.), model aliases, relative file paths

#### 7.3 Key Bindings (Non-Editor)

- **Ctrl-C**: if busy → pause generation; if idle → cancel current input (or exit if empty twice)
- **Ctrl-D**: if empty prompt → close tab (with confirmation if last tab → exit)
- **Ctrl-L**: clear screen and re-render
- **Ctrl-N**: new tab (create session)
- **Ctrl-T**: new tab (same as Ctrl-N)
- **Ctrl-F**: fork current session
- **Ctrl-Left/Right**: switch tabs (Alt-Left/Right also work as word movement)
- **Ctrl-Tab / Ctrl-Shift-Tab**: switch tabs (on supported terminals)
- **Escape**: cancel current completion, or clear selection

#### 7.4 Slash Commands

User types `/command` in the prompt:

- `/pause` — abort current generation
- `/continue` or `/c` — continue interrupted response
- `/model [name]` — switch model or list available
- `/topic [name]` — set session topic
- `/reset` — clear conversation history
- `/compact` — compact context
- `/resume [id]` — reopen closed session
- `/fork` — fork session
- `/cd [path]` — change working directory
- `/bug [description]` — capture debug snapshot
- `/[todo] text` — append to TODO.md

#### 7.5 Message Rendering

**Conversation display:**
- User messages: prefixed with `>` in dim style, show prompt text
- Assistant text: rendered with markdown support
- Thinking blocks: collapsed by default, expandable (show as `[thinking NN tokens]` or similar)
- Tool calls: show tool name + args preview while running, output on completion
- Info/meta messages: styled by level (dim for meta, yellow for warn, red for error)
- Questions (ask tool): highlighted with prompt for user input

**Markdown rendering** (`render.ts`):
- Code blocks: syntax-highlighted with language label
- Inline code: highlighted
- Bold, italic
- Headers
- Lists (ordered and unordered)
- Horizontal rules
- Links
- Blockquotes

**Streaming:**
- Text chunks arrive via `chunk` events, accumulated per session
- Render updates on each chunk (debounced for performance)
- Thinking chunks shown in real-time with token count

**Scrolling:**
- Mouse wheel scrolls message area
- When scrolled up during streaming, stays at scroll position (doesn't jump to bottom)
- Auto-scrolls to bottom on new user prompt

#### 7.6 Tab Bar

- Shows all open sessions as tabs
- Active tab highlighted
- Each tab shows: session ID, topic (if set), model display name
- Context indicator: shows token usage (e.g. `42K/200K`) if tracked
- Busy indicator: shows activity text or spinner for busy sessions
- Click to switch tabs (mouse support)

#### 7.7 Status Line

- Shows current model display name
- Context usage bar/numbers
- Activity text while busy (tool names, "thinking...", etc.)
- Paused indicator

#### 7.8 Blink Tag

`<blink />` or `<blink ms="400" />` in streamed assistant text inserts a pause (50ms default). Stripped from displayed output. Used for dramatic timing in responses.

---

### Phase 8: Context Management

**Files:** `session/prune.ts`

#### 8.1 Pruning Strategy

Applied when building API messages to keep context within limits. Configurable thresholds.

**What gets pruned (from oldest to newest):**
1. **Tool results**: large tool outputs are replaced with `[pruned — N chars]` after they're old enough. Keeps the tool call but removes the bulky result.
2. **Image content blocks**: replaced with `[image omitted from context — blob <id>; use read_blob if needed]` text placeholder. Saves significant tokens.
3. **Thinking blocks**: assistant thinking is stripped from older messages (recent ones kept).
4. **System info messages**: old `[system]` messages pruned.

**Pruning is progressive**: more aggressive for older messages. Recent messages (last N turns) are never pruned.

#### 8.2 Compaction

Different from pruning — compaction is explicit (manual `/compact` or autocompact at 70% usage):
1. Collects all user messages from history
2. Builds a "compaction context" block: numbered list of user prompts with abbreviated assistant response indicators
3. Rotates the log file (old log preserved as `history-NNNN.asonl`)
4. Writes the compaction context as the first user message in the new log
5. Continues with dramatically reduced context

---

### Phase 9: System Prompt & Project Instructions

**Files:** `runtime/system-prompt.ts`, `SYSTEM.md`, `AGENTS.md`

#### 9.1 SYSTEM.md Template

The main system prompt lives in `$HAL_DIR/SYSTEM.md`. It's a markdown file with:
- Agent identity and capabilities
- Rules for behavior (verify before agreeing, test changes, etc.)
- Coding style guidelines
- Session/fork semantics explained to the model
- Tool usage instructions
- Project-specific rules

**Preprocessor directives:**
- `${variable}` substitution (model, date, cwd, hal_dir, session_dir, eval)
- `::: if model="glob"` ... `:::` conditional blocks (include content only for matching models)
- HTML comment stripping (`<!-- ... -->`)
- Blank line collapsing

#### 9.2 AGENTS.md Chain

For project-specific instructions:
1. Find git root from session's working directory
2. Walk every directory from git root down to cwd
3. In each directory, look for `AGENTS.md` (or `CLAUDE.md` as fallback)
4. Collect all found files
5. Append their content to the system prompt in order (root → leaf)

This means a monorepo can have repo-level instructions at root and package-specific instructions in subdirectories.

On `/cd` to a new directory, the system reports which agent files were found.

---

### Phase 10: Advanced Features

#### 10.1 Prompt Analysis (Debug Mode)

When `config.debug` is true, fires a parallel fast-model call on each user prompt to classify:
- Mood (neutral/frustrated/happy/curious/urgent/playful)
- Whether it's a Hal self-modification request
- Topic (2-5 words)
- Duration of classification call

Results shown as `[analysis]` info line. Non-blocking — doesn't delay the main response.

#### 10.2 Hot Patchability

The codebase is designed for runtime monkey-patching via the `eval` tool:

- Most modules export a mutable namespace object: `export const moduleName = { fn1, fn2, ... }`
- Cross-module calls go through these objects: `moduleName.fn()` not `fn()` directly
- Eval scripts can import modules with `~src/` prefix and patch functions
- Changes take effect immediately for all future calls
- Config values that are tuning knobs go in mutable config objects (not `const`)

This allows the model to fix bugs in its own tools, adjust thresholds, or add behavior without restarting.

#### 10.3 Test Driver

`cli/test-driver.ts` — lightweight TUI testing harness:
- `TestDriver` class simulates terminal input/output
- Methods: `type(chars)`, `sendKey(key)`, assert text/cursor/selection state
- Used for testing prompt editor behavior, keybindings, completion
- Tests live alongside code as `.test.ts` files
- Parallel test runner (`./test` script) for speed

#### 10.4 Debug Logging

Structured debug log (`state/debug.log`) with timestamped entries. Modules can log with tags:
- `[ipc]`, `[runtime]`, `[provider]`, `[tools]`, etc.
- `/bug` command captures terminal snapshot + recent debug log for issue reporting
- Also captures terminal screenshot state for visual debugging

#### 10.5 Multiple Concurrent Sessions

- Sessions run independently with separate conversation histories
- Each can use a different model
- Each has its own working directory
- Tool execution uses the session's working directory
- Multiple sessions can be generating simultaneously (the runtime tracks busy set)
- Pause/continue per session

#### 10.6 Restart & Handoff

- Exit code 100 triggers restart via the shell wrapper
- Before exit, runtime writes handoff state to `state.ason`
- New process reads handoff within 10s window
- Resumes all previously open sessions
- No conversation data is lost (everything is in append-only logs)

---

## Ossified Components (Reuse As-Is)

These modules are stable, well-tested, and can be carried over with little or no changes:

1. **`utils/ason.ts`** (~400 LOC) — ASON parser/serializer. Battle-tested, comprehensive.
2. **`ipc.ts`** — File-backed IPC bus. Simple, reliable, no external dependencies.
3. **`session/session.ts`** + **`session/history.ts`** + **`session/history-fork.ts`** — Session persistence, fork chains. Well-structured.
4. **`session/blob.ts`** — Blob store. Minimal, correct.
5. **`tools/edit.ts`** — Hashline-based editing. The hash verification design is excellent.
6. **`tools/read.ts`** — Hashline file reading. Pairs with edit.
7. **`utils/live-file.ts`** — Live-reloading file cache. Clean utility.
8. **`runtime/eval-tool.ts`** — In-process eval. Clever import rewriting.

## Design Principles

1. **Files as IPC** — no sockets, no daemons. Append-only ASONL logs are the communication bus. Simple, debuggable, resilient to crashes.
2. **Append-only history** — conversation is never mutated in place. Compaction rotates to a new file. Fork chains link files.
3. **Session-scoped everything** — working directory, model, context, history. Tabs are real independent sessions.
4. **Hashline editing** — the `read`/`edit` tool pair uses line hashes to verify the model is editing the right content. Catches stale reads.
5. **Hot patchability** — namespace objects + eval tool = runtime self-modification. The model can fix its own tools.
6. **Progressive pruning** — old context is pruned in stages (tool results → images → thinking → compaction) rather than hard-truncated.
7. **Streaming-first** — all provider responses stream. Tool outputs stream. The TUI renders incrementally.
8. **No build step** — Bun runs TypeScript directly. No compilation, no bundling.
