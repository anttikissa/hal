# Hal Feature Specification

A comprehensive specification of every feature in Hal — a multi-session terminal-based AI coding agent. Written so that a coding agent could rebuild a similarly-featured system from scratch.

**Current codebase: ~8.3K LOC** (non-test TypeScript + Bun, no build step).

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Build Order](#2-build-order)
3. [Phase 0: Module System & Hot Patching](#3-phase-0-module-system--hot-patching)
4. [Phase 1: Foundation](#4-phase-1-foundation)
5. [Phase 2: IPC Bus](#5-phase-2-ipc-bus)
6. [Phase 3: Session Persistence](#6-phase-3-session-persistence)
7. [Phase 4: Terminal Input Layer](#7-phase-4-terminal-input-layer)
8. [Phase 5: TUI Rendering Engine](#8-phase-5-tui-rendering-engine)
9. [Phase 6: Provider Adapters](#9-phase-6-provider-adapters)
10. [Phase 7: Runtime & Agent Loop](#10-phase-7-runtime--agent-loop)
11. [Phase 8: Tools](#11-phase-8-tools)
12. [Phase 9: Context Management](#12-phase-9-context-management)
13. [Phase 10: System Prompt](#13-phase-10-system-prompt)
14. [Phase 11: Startup, Install & Operations](#14-phase-11-startup-install--operations)
15. [Phase 12: Testing & Performance](#15-phase-12-testing--performance)
16. [Ossified Components](#16-ossified-components)

---

## 1. Architecture Overview

Hal is a single-process Bun application where the first instance becomes the **host** (runs the AI runtime) and subsequent instances become **clients** (TUI only). All communication happens through file-backed IPC — no sockets, no HTTP.

```
┌─────────────────────────────────────────┐
│  Process (host+client OR client-only)   │
│                                         │
│  ┌─────────┐    ┌──────────────────┐    │
│  │   CLI   │◄──►│     Client       │    │
│  │ (TUI)   │    │ (block model)    │    │
│  └─────────┘    └────────┬─────────┘    │
│                          │              │
│                    ┌─────┴─────┐        │
│                    │ Transport │        │
│                    └─────┬─────┘        │
│                          │              │
│               ┌──────────┴──────────┐   │
│               │   File-backed IPC   │   │
│               │  (commands/events/  │   │
│               │   state.ason)       │   │
│               └──────────┬──────────┘   │
│                          │              │
│                 ┌────────┴────────┐     │
│                 │    Runtime      │     │
│                 │  (host only)    │     │
│                 │  agent loop     │     │
│                 │  tools          │     │
│                 │  providers      │     │
│                 └─────────────────┘     │
└─────────────────────────────────────────┘
```

Key principle: **the host and client can be in the same process.** The first process to start claims host, runs the runtime, AND runs the CLI. Additional processes run client-only, connecting to the same IPC bus.

### Data flow

1. User types in CLI → prompt text captured
2. CLI sends `RuntimeCommand` (e.g. `{ type: 'prompt', text: '...' }`) to IPC commands log
3. Runtime tails commands log, processes command
4. Runtime streams `RuntimeEvent`s (chunks, tool status, etc.) to IPC events log
5. Client tails events log, updates block model, triggers render

---

## 2. Build Order

The phases below are ordered for maximum testability at each step. Each phase produces something that works end-to-end before adding the next layer.

| Phase | What | Why first |
|-------|------|-----------|
| 0 | Module system & hot patching | Determines how ALL code is structured |
| 1 | Foundation (ASON, state, config, utils) | Everything depends on these |
| 2 | IPC bus | Host/client communication substrate |
| 3 | Session persistence | History must exist before runtime can use it |
| 4 | Terminal input layer | Key parsing before TUI |
| 5 | TUI rendering engine | Visible feedback loop |
| 6 | Provider adapters | API calls before agent loop |
| 7 | Runtime & agent loop | The brain |
| 8 | Tools | What the agent can do |
| 9 | Context management | Keeping conversations within limits |
| 10 | System prompt | SYSTEM.md preprocessing |
| 11 | Startup, install & operations | Entry points, restart, handoff |
| 12 | Testing & performance | Automated guards |

---

## 3. Phase 0: Module System & Hot Patching

**This must be decided before writing any code.** It determines the structure of every module.

### 3.1 Module pattern

Every runtime module exports a mutable namespace object. Functions are defined at module scope, then grouped into a single exported const:

```typescript
function doThing() { ... }
function otherThing() { ... }

export const myModule = { doThing, otherThing }
```

Cross-module calls always go through the namespace:

```typescript
import { myModule } from './my-module.ts'
myModule.doThing()  // NOT: import { doThing } from './my-module.ts'
```

This enables eval-time monkey patching:

```typescript
import { myModule } from '~src/my-module.ts'
const orig = myModule.doThing
myModule.doThing = () => { console.log('patched!'); return orig() }
```

**Rules:**
- Direct exports only for types, interfaces, and true constants (regexes, paths, schemas)
- Runtime tuning knobs (thresholds, timeouts, size limits) go in a mutable exported config object, read at call time
- Class-based modules (e.g. `Runtime`) are patched via instance or prototype

### 3.2 No code on import

**No module may execute side effects when imported.** Every module that needs initialization must expose an `init()` function called by its owner (whoever imports it first in the startup chain).

**Why:** The startup budget is 100ms total — 50ms to load all code, 50ms to restore session state and show a responsive UI. `import` must be pure.

**Exception:** The CLI module (`cli.ts`) is the terminal entry point — it sets up stdin/stdout. It's the last thing imported, after the runtime is ready.

### 3.3 Mutable config objects

```typescript
export const pruneConfig = {
    maxImageAge: 4,
    maxThinkingAge: 6,
    maxToolOutputSize: 800,
    maxToolOutputAge: 6,
}
```

These are read at call time (not captured at import time), so eval patches take effect immediately.

---

## 4. Phase 1: Foundation

### 4.1 ASON — Serialization Format

ASON ("Almost JSON") is a superset of JSON used for all config, state, and history files. It adds:

- **Trailing commas** in arrays and objects
- **Comments:** `//` line comments and `/* */` block comments
- **Unquoted keys** when they are valid identifiers
- **Multi-line strings:** backtick-delimited `` `...` `` with escape support
- **Raw strings:** `r` prefix, like `` r`no\escapes` ``
- **Optional quotes** on simple string values (configurable)
- **`undefined`** as a value (serializes to `undefined`, deserializes to `undefined`)

**ASONL** = newline-delimited ASON. Each line is one ASON value. Used for append-only logs (history, IPC events/commands).

**Key functions:**
- `ason.parse(text)` → value (superset of JSON.parse)
- `ason.stringify(value, opts?)` → string
- `ason.parseAll(text)` → array of values (for ASONL)

**This is an ossified component** — carry over as-is.

### 4.2 State directory structure

```
$HAL_STATE_DIR/              (default: $HAL_DIR/state)
├── ipc/
│   ├── host.lock            (owner lock file)
│   ├── state.ason           (current runtime state)
│   ├── events.asonl         (append-only event stream)
│   └── commands.asonl       (append-only command stream)
├── sessions/
│   ├── AB-CDE/              (session ID: 2-digit + 3-char random)
│   │   ├── session.ason     (metadata: id, workingDir, model, createdAt, etc.)
│   │   ├── history.asonl    (conversation log)
│   │   ├── history-1.asonl  (rotated log after compaction)
│   │   ├── blobs/           (tool call/result data, thinking blocks)
│   │   │   └── *.ason
│   │   ├── eval/            (eval tool scripts — never deleted)
│   │   ├── images/          (persisted user-attached images)
│   │   └── draft.txt        (unsent prompt text)
│   └── ...
├── client.ason              (client-side state: last active tab)
└── debug.log                (debug logging output)
```

Session IDs are formatted as `MM-xxx` where MM is a zero-padded month and xxx is a 3-character lowercase alphanumeric random suffix. This makes sessions naturally sortable by creation month.

### 4.3 Config & Auth

**`$HAL_DIR/config.ason`** — non-secret settings:
```ason
{
    defaultModel: "anthropic/claude-opus-4-6",
    permissions: "yolo",
}
```

**`$HAL_DIR/auth.ason`** — gitignored secrets:
```ason
{
    anthropic: { accessToken: "sk-ant-..." },
    openai: { accessToken: "sk-..." },
}
```

Both are loaded via `liveFile()` — a utility that creates a proxy object backed by a file. Reading a property reads from the in-memory cache; writing triggers a debounced save. File changes on disk (from another process or manual edit) are detected via `fs.watch()` and merged.

### 4.4 Live File

`liveFile<T>(path, { defaults })` → `T` (proxy)

- Creates file with defaults if it doesn't exist
- Returns a deeply-reactive Proxy that auto-saves on mutation
- Watches for external changes and reloads
- Debounces writes (avoids write storms)
- Used for config.ason, auth.ason, session.ason, client.ason

**This is an ossified component.**

### 4.5 Read File Cache

`readFiles.readText(path, caller)` / `readFiles.readTextSync(path, caller)` — a thin caching layer over file reads. Tracks caller for debugging. Avoids re-reading files that haven't changed (stat-based).

### 4.6 String Utilities

- `strings.visLen(s)` — visible length of string (ignoring ANSI escapes, handling wide chars via `charWidth`)
- `strings.charWidth(codepoint)` — East Asian Width awareness (CJK = 2, emoji = 2, etc.)
- `strings.wordWrap(text, width)` — word-wrap with ANSI-awareness
- `strings.clipVisual(s, maxWidth)` — clip to visual width with ANSI preservation

### 4.7 Log Utility

`Log<T>` — generic append-only ASONL file. Used by IPC (events, commands) and session history.

- `append(...items)` — serialize and append atomically
- `readAll()` — parse entire file
- `tail(fromOffset?)` — async generator that yields new items as they're appended (uses `fs.watch` + polling fallback)
- `offset()` — current file size (for resume)

---

## 5. Phase 2: IPC Bus

File-backed inter-process communication. No sockets, no HTTP — just files.

### 5.1 Host Election

Only one process can be the host (running the AI runtime). Election uses an exclusive file lock:

1. Try to create `ipc/host.lock` with `open('wx')` (exclusive create — atomic)
2. Write `{ pid, hostId, createdAt }` into it
3. If creation fails (file exists), read existing lock → check if PID is alive via `process.kill(pid, 0)`
4. If PID is dead, unlink stale lock and retry
5. Winner becomes host; losers become client-only

The `hostId` is `${pid}-${randomHex}` for uniqueness.

### 5.2 Host Verification & Heartbeat

The host periodically (every 3s) verifies it still owns the lock by reading the lock file and checking the hostId matches. If another process took over (e.g. after the host was suspended), it steps down and exits with code 100 (triggering restart).

### 5.3 Client Promotion

When the host dies, a client can take over:

1. Client polls the host PID every 20ms via `process.kill(pid, 0)`
2. When the PID is gone, client attempts `claimHost()`
3. On success: imports the runtime, restores sessions, starts the agent loop
4. Event-driven fast path: host emits `[host-released]` event before quitting; client's event handler calls `tryPromote()` immediately without waiting for poll

### 5.4 Handoff State

When the host quits or restarts, it writes a handoff record to `state.ason`:

```ason
{
    handoff: {
        mode: "continue",
        reason: "restart",    // or "quit"
        fromPid: 12345,
        createdAt: "2026-03-13T...",
        activeSessionIds: ["03-abc", "03-def"],
        busySessionIds: ["03-abc"],
    }
}
```

The next host (restarted process or promoted client) reads this and:
- If `reason` is `"restart"` and within the time window (default 10s): automatically continues busy sessions
- If `reason` is `"quit"` and within the time window: automatically continues busy sessions
- Busy sessions that were working **continue**; sessions that were paused do **not** auto-continue

**Critical rule:** The current active tab must be preserved across restarts and promotions. The client persists its last-viewed tab in `client.ason` and restores it on startup.

### 5.5 IPC Channels

**Commands** (client → host): `ipc/commands.asonl`
```ason
{ id: "cmd_abc123", type: "prompt", text: "Hello", sessionId: "03-abc", source: { kind: "cli", clientId: "f0a1" } }
```

Command types:
- `prompt` — user message (with optional `text`, `attachments`)
- `interrupt` — stop current generation (Ctrl-C during busy)
- `open` — create new session/tab (with optional `workingDir`)
- `close` — close session/tab
- `compact` — trigger history compaction (`/compact` command)
- `continue` — retry/continue after error or interruption
- `switch` — change active session on runtime side
- `set-model` — change model for a session
- `cd` — change working directory

**Events** (host → client): `ipc/events.asonl`
```ason
{ id: "evt_1", type: "chunk", sessionId: "03-abc", text: "Hello", channel: "text" }
{ id: "evt_2", type: "chunk", sessionId: "03-abc", text: "thinking...", channel: "thinking", blobId: "abc123" }
{ id: "evt_3", type: "tool", sessionId: "03-abc", phase: "running", toolId: "tu_1", name: "bash", args: "ls -la" }
{ id: "evt_4", type: "tool", sessionId: "03-abc", phase: "streaming", toolId: "tu_1", output: "file1.txt\n" }
{ id: "evt_5", type: "tool", sessionId: "03-abc", phase: "done", toolId: "tu_1", output: "file1.txt\nfile2.txt\n" }
{ id: "evt_6", type: "status", busySessionIds: ["03-abc"], contexts: { "03-abc": { used: 5000, max: 200000 } } }
{ id: "evt_7", type: "sessions", sessions: [ { id: "03-abc", ... } ] }
{ id: "evt_8", type: "line", sessionId: "03-abc", text: "[system] reloaded SYSTEM.md", level: "meta" }
{ id: "evt_9", type: "prompt", sessionId: "03-abc", text: "User's prompt" }
{ id: "evt_10", type: "question", sessionId: "03-abc", questionId: "q1", text: "Which file?" }
```

**State** (shared snapshot): `ipc/state.ason`
```ason
{
    sessions: ["03-abc", "03-def"],
    activeSessionId: "03-abc",
    busySessionIds: ["03-abc"],
    handoff: null,
    pendingQuestions: {},
    contexts: {},
}
```

### 5.6 Transport Abstraction

The Client doesn't use IPC directly — it goes through a `Transport` interface:

```typescript
interface Transport {
    sendCommand(cmd: RuntimeCommand): Promise<void>
    bootstrap(): Promise<{ state: RuntimeState; sessions: SessionInfo[] }>
    tailEvents(fromOffset?: number): AsyncIterable<RuntimeEvent>
    hydrateSession(id: string): Promise<HydrationData>
    eventsOffset(): Promise<number>
}
```

`LocalTransport` implements this using the file-backed IPC. This abstraction exists so that a future web client can use a WebSocket transport instead.

---

## 6. Phase 3: Session Persistence

### 6.1 Session Metadata

Each session has a `session.ason`:
```ason
{
    id: "03-abc",
    workingDir: "/Users/me/project",
    model: "anthropic/claude-opus-4-6",
    createdAt: "2026-03-06T...",
    topic: "refactor auth",
    log: "history.asonl",
    context: { used: 15000, max: 200000 },
}
```

`workingDir` determines where tools execute (bash cwd, file read/write/edit paths). It can be changed at runtime via `/cd`.

### 6.2 History Log

Append-only ASONL. Entry types:

```typescript
type Message =
    | { role: 'user'; content: string | ContentBlock[]; ts: string }
    | { role: 'assistant'; text?: string; thinkingText?: string; thinkingBlobId?: string;
        thinkingSignature?: string; tools?: ToolRef[]; usage?: Usage; ts: string }
    | { role: 'tool_result'; tool_use_id: string; blobId: string; ts: string }
    | { type: 'info'; text: string; level?: 'error' | 'warn' | 'meta'; ts: string }
    | { type: 'reset'; ts: string }
    | { type: 'compact'; ts: string }
    | { type: 'forked_from'; parent: string; ts: string }
    | { type: 'session'; action: 'init' | 'model-set' | 'model-change' | 'cd';
        model?: string; cwd?: string; ts: string }
```

The history log stores *references* to large data (tool inputs/outputs, thinking blocks) via blob IDs. The actual data lives in the blobs directory.

### 6.3 Blobs

`blobs/<id>.ason` — ASON files storing:
- Tool call input + result: `{ call: { name, input }, result: { content, status } }`
- Thinking blocks: `{ thinking: "...", signature: "..." }`
- Images: `{ media_type: "image/png", data: "base64..." }`
- Eval scripts: stored in `eval/` directory

Blob IDs are generated as 5-char lowercase alphanumeric random strings.

### 6.4 Fork Chains

A session can be forked (`/fork` or Ctrl-F):
1. New session directory created with fresh `session.ason`
2. First line of child's `history.asonl`: `{ type: 'forked_from', parent: 'XX-yyy', ts: '...' }`
3. `loadAllHistory(id)` follows the fork chain recursively: reads parent's history, then overlays child's entries
4. `readBlob(sessionId, blobId)` walks the fork chain — blobs from parent sessions are resolved from parent's `blobs/` directory

### 6.5 History Compaction

`/compact` command (also triggered automatically when context is full):
1. Builds a compaction summary from user prompts in the current history
2. Writes a `{ type: 'compact', ts }` marker
3. Rotates the log file: `history.asonl` → `history-1.asonl`, fresh `history.asonl`
4. Injects compaction context as the first user message in the new log
5. Updates `session.ason` with new log name

The compaction summary lists user prompts (first 10 + last 10 if >20 total) and a pointer to the full history files.

### 6.6 History → Blocks Pipeline (Hydration)

Converting stored history entries to displayable UI blocks is a critical performance path. The pipeline:

1. **Read** — `readHistory(sessionId)` loads the ASONL file
2. **Fork resolution** — `loadAllHistory()` follows fork chains to build complete message list
3. **Replay** — `replay.replayToBlocks()` walks messages and produces `Block[]`:
   - User messages → `{ type: 'input', text, model }`
   - Assistant messages → `{ type: 'assistant', text, done: true, model }`
   - Thinking blocks → `{ type: 'thinking', text, done: true, blobId, model }`
   - Tool calls → `{ type: 'tool', name, args, output, status: 'done' }`
   - Info/error entries → `{ type: 'info' | 'error', text }`
4. **Display** — blocks are rendered to terminal lines (see Phase 5)

**Progressive startup hydration** for long sessions (≥400 messages):
- Load the tail (last ~120 messages) first → render immediately
- Hydrate older messages in the background (in a Web Worker or chunked in-process)
- Prepend older blocks to the display as they're ready
- Show "loading history" indicator in the separator bar while background hydration runs

### 6.7 Drafts

Unsent prompt text is persisted to `draft.txt` in the session directory:
- Saved on tab switch, restart, and periodically
- Restored when the tab is re-activated
- Images referenced in drafts that point to `/tmp/` paths are copied to the session's `images/` directory to survive tmp cleanup

### 6.8 Input History

Per-session input history (last 200 user messages) for Ctrl-Up/Ctrl-Down navigation. Extracted from history entries during hydration. Only non-system, non-empty messages are included.

---

## 7. Phase 4: Terminal Input Layer

### 7.1 Key Parsing

Raw stdin arrives as byte sequences that vary wildly across terminals. The parser normalizes them to structured `KeyEvent` objects:

```typescript
interface KeyEvent {
    key: string       // 'a', 'left', 'up', 'enter', 'backspace', 'tab', 'escape', etc.
    char?: string     // printable character to insert (may be multi-byte from paste)
    shift: boolean
    alt: boolean      // Option key on macOS
    ctrl: boolean
    cmd: boolean      // Super/Meta key; Command (⌘) on macOS
}
```

**Input sequence types handled:**

1. **CSI sequences** (`\x1b[...X`):
   - Arrow keys: `\x1b[A` (up), `\x1b[B` (down), `\x1b[C` (right), `\x1b[D` (left)
   - Modified arrows: `\x1b[1;2D` (shift+left), `\x1b[1;5C` (ctrl+right)
   - Tilde keys: `\x1b[3~` (delete), `\x1b[5~` (pageup), `\x1b[6~` (pagedown)
   - Home/End: `\x1b[H`, `\x1b[F`

2. **Kitty keyboard protocol** (`\x1b[...u`):
   - Full CSI u encoding: `\x1b[codepoint;modifier;textu`
   - Modifier bits: shift=1, alt=2, ctrl=4, super(cmd)=8 (raw value = 1 + bitmask)
   - Event types: `:1` press, `:2` repeat, `:3` release (releases are ignored)
   - Text field for printable keys (`;textcodepoint` suffix)
   - Special codepoints: 13=enter, 9=tab, 27=escape, 127=backspace
   - Private-use area codepoints ignored (function keys etc.)
   - Enabled on kitty/ghostty/iTerm.app via `\x1b[>1u` (progressive enhancement)

3. **Alt+key** (`\x1b` + char):
   - `\x1bb` → alt+left (word back), `\x1bf` → alt+right (word forward)
   - `\x1b\x7f` → alt+backspace
   - `\x1b` + printable → alt+key

4. **Control characters** (byte 0-31):
   - Mapped via lookup table: 0=ctrl+space, 1=ctrl+a, ..., 26=ctrl+z, 27=escape
   - Tab (9), Enter (10/13), Backspace (8/127) are their own keys (no ctrl flag)

5. **Bracketed paste** (`\x1b[200~...content...\x1b[201~`):
   - Content between delimiters emitted as single `char` value
   - Cross-chunk handling: if paste start arrives but end is in a later data event, content is buffered across events

**Tokenizer:** Raw stdin data is split into individual key sequences before parsing. The tokenizer handles:
- Interleaved escape sequences
- Multi-byte UTF-8 characters
- Concatenated sequences (multiple keys in one data event)
- Paste buffering across chunk boundaries

### 7.2 Keybindings

The keybinding layer maps `KeyEvent` → action. It receives an `InputContext` interface providing access to all client/CLI operations:

**Navigation:**
- `ctrl+n` / `ctrl+p` — next/previous tab
- `ctrl+1` through `ctrl+9` — switch to tab N (via kitty cmd+N)
- `ctrl+t` — new tab (open session)
- `ctrl+w` — close current tab
- `ctrl+l` — redraw screen (clear + re-render)
- `ctrl+z` — suspend process (SIGSTOP)
- `ctrl+r` — restart (exit 100)
- `ctrl+c` — quit (with confirmation if destructive tools are running)

**Prompt editing:** (delegated to prompt module)
- All printable characters, backspace, delete, arrows, word movement, home/end
- `enter` — submit prompt (or answer question)
- `ctrl+c` while busy — interrupt generation
- `shift+enter` — insert newline
- `alt+enter` — insert newline
- `ctrl+up` / `ctrl+down` — navigate input history
- `pageup` / `pagedown` — scroll viewport
- `tab` — accept/cycle completions

**Command dispatch:** Input starting with `/` is a command:
- `/compact` — compact history
- `/model <name>` — change model
- `/cd <path>` — change working directory
- `/fork` — fork session
- `/continue` — retry/continue after error
- `/bug <desc>` — capture debug info
- Any unknown `/` command is sent as-is (runtime handles it)

---

## 8. Phase 5: TUI Rendering Engine

### 8.1 Block Content Model

The UI is built around a **block model** — the conversation is a list of typed blocks:

```typescript
type Block =
    | { type: 'input'; text: string; model?: string; source?: string; status?: 'queued' | 'steering' }
    | { type: 'assistant'; text: string; done: boolean; model?: string }
    | { type: 'thinking'; text: string; done: boolean; blobId?: string; model?: string; sessionId?: string }
    | { type: 'info'; text: string }
    | { type: 'error'; text: string; detail?: string; blobId?: string }
    | { type: 'tool'; toolId?: string; name: string; status: 'streaming' | 'running' | 'done' | 'error';
        args: string; output: string; startTime: number; endTime?: number; blobId?: string; sessionId: string }
```

Each block type has its own renderer that produces terminal lines (strings with ANSI escapes).

### 8.2 Block Rendering

Every block is rendered as a colored box with a 1-char margin on each side and 1-char padding inside:

```
 ── Label ──────────────────────────────────
 │ Content line 1                          │
 │ Content line 2                          │
```

- **Input blocks**: user prompt with model name, colored background
- **Assistant blocks**: markdown-rendered response with model label
- **Thinking blocks**: short thinking shown as plain colored text; long thinking (≥5 lines) shown as a boxed block with a header, capped at 10 visible lines with "[+ N lines]" indicator
- **Tool blocks**: header shows `name: args (elapsed)`, multi-line command display for bash, output capped at 5 lines with "[+ N lines]" for hidden output
- **Info blocks**: single-line colored text
- **Error blocks**: red box with formatted error detail (JSON auto-pretty-printed)

**Block headers** can include clickable blob links: `[sessionId/blobId]` rendered as terminal hyperlinks (`\x1b]8;;file://path\x07text\x1b]8;;\x07`) pointing to the blob file.

### 8.3 Markdown Rendering

Custom markdown-to-ANSI renderer (not a library). Handles:

- **Inline formatting**: `**bold**`, `*italic*`, `` `code` ``, `[link](url)`, `~~strikethrough~~`
- **Code blocks**: fenced with ``` — rendered with distinct background color, no word wrap
- **Tables**: aligned with `|` columns, inline formatting applied within cells
- **Paragraphs**: word-wrapped to content width, ANSI-aware
- **Block structure detection**: `mdSpans()` splits text into spans of type `text`, `code`, or `table`

### 8.4 Block Fingerprinting & Render Cache

**Performance-critical:** On every prompt keystroke, the full block list is "rendered" but blocks that haven't changed are served from cache.

The fingerprint is a fast non-cryptographic hash (FNV-1a variant using `Math.imul`) computed over all fields that affect visible output:
- Block type code
- Text content (character-by-character hash)
- Status flags (done, streaming, etc.)
- Model, blobId, args, output, etc.

`blocksFingerprint(blocks)` → single 32-bit number. Cache key is `(sessionId, width, cursorVisible, fingerprint)`.

If the cache key matches, the previously rendered lines are reused without re-running any block renderer. This makes prompt editing feel instant even with hundreds of blocks.

### 8.5 Diff Engine

Instead of clearing the screen on every render, the diff engine computes minimal ANSI escape sequences to update only changed lines:

1. Compare new lines vs. previous lines
2. Find first and last changed line indices
3. For unchanged-length lines: try **intra-line patching** (find common prefix, emit cursor-move + changed substring only)
4. For appends: move to last old line, `\r\n` into new territory
5. For shrinks: clear extra lines with `\x1b[2K`
6. Position cursor at target location

**Synchronized output:** All frame writes are wrapped in `\x1b[?2026h` ... `\x1b[?2026l` (synchronized output protocol). The terminal buffers everything between these markers and paints in one atomic frame, eliminating flicker. Supported by kitty, ghostty, iTerm.

The diff engine maintains a `RenderState`:
```typescript
interface RenderState {
    lines: string[]
    cursorRow: number
    cursorCol: number
}
```

### 8.6 Screen Layout

The screen is composed top-to-bottom:

```
┌─ Content area (scrollable blocks) ──────┐
│ [input block]                            │
│ [assistant block]                        │
│ [tool block]                             │
│ ...                                      │
│                                          │
│ [cursor line]                            │
│                                          │
├─ Question area (if ask tool active) ─────┤
│ [question box]                           │
│ [answer input]                           │
│ ─── enter to submit ───                  │
├─ Tab bar ────────────────────────────────┤
│  [1▪.hal] 2 project  3 docs             │
├─ Separator ──────────────────────────────┤
│ ── You › Hal (opus, idle) ── client · 03-abc · ~12.5%/200k ──│
├─ Prompt area ────────────────────────────┤
│ > user input text                        │
├─ Help bar ───────────────────────────────┤
│ ─ ctrl-t new │ ctrl-w close │ ... ──     │
└──────────────────────────────────────────┘
```

**Padding:** Content is padded to the tallest tab's height so the prompt position stays stable when switching tabs.

**Streaming cursor:** During streaming, a block cursor (█) is inlined at the end of the last content line, colored to match the active block type (tool color, thinking color, or default). When idle, the cursor appears on its own line below the content.

**Cursor blinking:** A 530ms blink timer toggles cursor visibility. The cursor is always solid (visible) during streaming.

### 8.7 Tab Bar

Progressive degradation based on available width:

1. **Full titles** (max 12 chars): `[1▪.hal] 2 project`
2. **Medium titles** (8 chars): `[1▪.hal] 2 project`
3. **Short titles** (4 chars): `[1▪.hal] 2 pro`
4. **Numbers + busy only**: `[1▪] 2  3`
5. **Numbers + indicator**: `[1!] 2  3`

Active tab: `[N...]` in bright white. Inactive: ` N... ` in dim.

**Indicators:**
- `▪` (colored) — busy/streaming, color matches current block type
- `?` (question color) — `ask` tool waiting for user input
- `✖` (red) — last block was an error
- `!` — interrupted or paused
- `✓` (green) — completed while not viewed ("done unseen")

### 8.8 Separator Bar

Shows: `── You › Hal (model, state) ── role · sessionId · context% ──`

**State** derived from last block: `idle`, `thinking`, `tool`, `writing`, `pausing`.

**Context percentage** color-coded: green (<50%), yellow (50-70%), red (≥70%).

### 8.9 Prompt Editor

Multi-line text editor with:
- Character insertion at cursor position
- Cursor movement: left, right, up, down, word-left (alt+left), word-right (alt+right), home (ctrl+a), end (ctrl+e)
- Delete: backspace, delete, word-backspace (alt+backspace), kill-to-end (ctrl+k)
- Select all: ctrl+a (when at start of line)
- Newlines: shift+enter, alt+enter
- Scroll: when prompt exceeds visible area, shows top/bottom of visible window with scroll info in separator
- Input history: ctrl+up/ctrl+down cycles through previous prompts
- Tab completion for `/` commands and model names

**Word boundary algorithm:** Word movement stops at transitions between: whitespace, punctuation, alphanumeric. This matches editor-like behavior (not shell-like).

### 8.10 Tab Completion

Triggered by `/` at the start of input, then refined on each keystroke:

1. `/` shows all available commands
2. Typing filters: `/mo` shows `/model`
3. After `/model `, shows available model names
4. Tab cycles through matches; Enter accepts
5. Escape dismisses

Available completions include: `/compact`, `/model`, `/cd`, `/fork`, `/continue`, `/bug`, and model names from the configured providers.

### 8.11 Clipboard

- **Paste:** Handled via bracketed paste (terminal sends paste delimiters). Multi-line pastes are inserted as-is.
- **Copy:** Not directly handled (terminal's native selection/copy works). But `[file://path]` hyperlinks in blob references allow clicking to open in editor.

### 8.12 Question Flow (Ask Tool)

When the `ask` tool fires:
1. Runtime sends a `question` event
2. Client shows a question box above the tab bar
3. Main prompt is "frozen" (shown dimmed below tab bar, not editable)
4. A new answer input appears below the question
5. User types answer and hits Enter
6. Answer sent as command; question dismissed
7. Main prompt unfrozen

### 8.13 Viewport Scrolling

PageUp/PageDown scroll through the content area:
- Content is rendered as full block list
- Viewport offset tracks which portion is visible
- Scroll position shown in separator bar: "line X-Y of Z"
- Any new content (streaming) auto-scrolls to bottom

### 8.14 Resize Handling

On terminal resize (`stdout.on('resize')`):
- Render state is fully cleared
- Full re-render with new dimensions
- All caches invalidated (fingerprint cache uses width as key)

---

## 9. Phase 6: Provider Adapters

### 9.1 Anthropic Provider

**Streaming via SSE** to `https://api.anthropic.com/v1/messages`:

- Request format: Anthropic Messages API (roles, content blocks, tool definitions)
- Streaming: `stream: true` → Server-Sent Events with `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop` events
- **Extended thinking**: `thinking: { type: 'enabled', budget_tokens: N }` — model returns `thinking` content blocks with signatures for verification
- **Prompt caching**: `cache_control: { type: 'ephemeral' }` on system prompt blocks — reduces cost on repeated calls with same system prompt
- **Tool definitions**: Converted to Anthropic format with JSON Schema input descriptions

**Auth:** Bearer token from `auth.ason` (`anthropic.accessToken`).

**Error handling:**
- 429 (rate limit): Retry with exponential backoff, read `retry-after` header
- 529 (overloaded): Retry with backoff
- 4xx: Surface error to user, formatted as error block
- Network errors: Surface with stack trace

**Response processing:**
- Text deltas → streamed as `chunk` events to client
- Thinking deltas → streamed as `chunk` events with `channel: 'thinking'`
- Tool use blocks → collected, emitted after streaming completes
- Usage stats → captured for context tracking

### 9.2 OpenAI Provider

**Streaming via SSE** to `https://api.openai.com/v1/chat/completions` (or `responses` endpoint):

- Request format: OpenAI Chat Completions API
- Message conversion: Anthropic content blocks → OpenAI messages
- Tool definitions: Converted to OpenAI function format
- Thinking support: `reasoning_effort` parameter for o-series models

### 9.3 Model Registry

Maps model IDs to display names and provider details:

```typescript
"anthropic/claude-opus-4-6"     → "opus"
"anthropic/claude-sonnet-4-20250514" → "sonnet"
"openai/o3"                         → "o3"
"openai/gpt-4.1"                    → "gpt-4.1"
```

`displayModel(id)` returns a short human-readable name for the separator bar and block headers.

---

## 10. Phase 7: Runtime & Agent Loop

### 10.1 Runtime Class

The `Runtime` is the host-side brain. It manages:

- `sessions: Map<string, SessionInfo>` — all known sessions
- `busySessionIds: Set<string>` — currently generating
- `activeSessionId: string` — which session is "focused"
- `sessionContext: Map<string, ContextInfo>` — token usage per session

### 10.2 Agent Loop

The core generate → tool-call → generate cycle:

```
1. User prompt arrives (via command)
2. Write user message to history
3. Build API messages from history (loadApiMessages)
4. Build system prompt (system-prompt.ts)
5. Call provider (streaming)
6. Stream chunks to client as events
7. When response complete:
   a. Write assistant message to history
   b. If tool calls present:
      - Execute each tool
      - Stream tool output as events
      - Write tool results to history
      - GOTO 3 (loop with tool results)
   c. If no tool calls: done, mark session not-busy
8. Publish updated status
```

**Concurrency:** Multiple sessions can be busy simultaneously. Each runs its own agent loop independently. The runtime processes commands sequentially but doesn't block on generation.

### 10.3 Command Handling

Commands are processed by `handleCommand()`:

- **prompt**: Write user message, start generation. Supports `attachments` (images as base64 blobs).
- **interrupt**: Cancel in-flight generation (abort controller), mark not-busy. If tools were running, record interrupted tool results.
- **open**: Create new session with optional working directory. Emit greeting.
- **close**: Remove session from state. Don't delete files (history preserved).
- **compact**: Trigger history compaction for the session.
- **continue**: Retry generation from current history state (after error or interruption).
- **switch**: Change `activeSessionId` (affects which session gets keyboard focus on the runtime side).
- **set-model**: Change model for a session. Write model-change event to history.
- **cd**: Change session's working directory. Write cd event to history.

### 10.4 Greeting

New sessions get a greeting message:
- First-ever session: `"Hello! I'm HAL. What can I help you with?"`
- Subsequent: Random variety (`"What's next?"`, `"Ready when you are."`, etc.)

Greeting is written as an assistant message to history AND emitted as a chunk event.

### 10.5 Auto-Compact

When context usage exceeds the threshold (currently when the provider returns an error indicating context is full, or when usage stats show >90%), the runtime automatically:
1. Emits info: `[system] context nearly full, compacting...`
2. Runs compaction
3. Continues the generation with the compacted context

### 10.6 Status Publishing

After every state change, the runtime publishes:
```ason
{
    id: "evt_...",
    type: "status",
    busySessionIds: ["03-abc"],
    contexts: {
        "03-abc": { used: 45000, max: 200000 },
    },
}
```

### 10.7 Prompt Analysis & Steering

Before sending a prompt to the model, the runtime can analyze it:
- Short prompts like "yes", "ok", "continue" → may be handled as commands
- Prompts that reference specific sessions or tools → routing

### 10.8 SYSTEM.md File Watching

The runtime watches `SYSTEM.md` and `AGENTS.md` for changes (via `fs.watch`). When either changes:
- Debounced (150ms) to coalesce rapid saves
- Emits info event: `[system] reloaded SYSTEM.md (file changed)`
- The system prompt is re-built on the next generation (not cached aggressively)

---

## 11. Phase 8: Tools

Tools are defined with a name, description, and JSON schema for parameters. They're passed to the AI provider as tool definitions, and executed when the model returns tool_use blocks.

### 11.1 bash

Execute shell commands. The most-used tool.

**Features:**
- Runs in session's `workingDir`
- Streams stdout/stderr chunks to client during execution (not just at completion)
- Configurable timeout (default: 120s for regular commands)
- Combined stdout+stderr output
- Exit code reporting
- For display: multi-line commands shown with `$` prefix, single-line shown inline

**Schema:**
```json
{ "command": { "type": "string", "description": "Shell command to execute" } }
```

### 11.2 read

Read file contents with line numbers and content hashes for editing.

**Features:**
- Returns lines in `LINE:HASH content` format (hashline format)
- Hash is a short hex string derived from the line content (for edit verification)
- Optional `start`/`end` line range
- Binary file detection (returns error)
- File-not-found returns clear error

**Schema:**
```json
{
    "path": { "type": "string" },
    "start": { "type": "integer", "description": "First line (1-based)" },
    "end": { "type": "integer", "description": "Last line (inclusive)" }
}
```

### 11.3 write

Create or overwrite a file.

**Schema:**
```json
{
    "path": { "type": "string" },
    "content": { "type": "string", "description": "Full file content (no hashline prefixes)" }
}
```

### 11.4 edit

Edit a file using hashline references from a previous `read`. Supports replace and insert operations.

**Replace:** Replace lines from `start_ref` to `end_ref` (inclusive) with `new_content`. If `new_content` is empty, deletes the range. Using the same ref for start and end replaces a single line.

**Insert:** Insert `new_content` after `after_ref`. Use `"0:000"` for beginning of file.

**Hash verification:** Each ref is `LINE:HASH`. The hash is verified against the current file content. If it doesn't match (file changed since last read), the edit fails with an error telling the model to re-read the file.

**Schema:**
```json
{
    "path": { "type": "string" },
    "operation": { "enum": ["replace", "insert"] },
    "start_ref": { "type": "string", "description": "LINE:HASH of first line" },
    "end_ref": { "type": "string", "description": "LINE:HASH of last line" },
    "after_ref": { "type": "string", "description": "LINE:HASH to insert after" },
    "new_content": { "type": "string", "description": "Replacement text (raw)" }
}
```

### 11.5 grep

Search file contents using ripgrep (`rg`).

**Features:**
- Shells out to `rg` for speed
- Returns matching lines with file paths and line numbers
- Optional `include` glob pattern to filter files
- Optional `path` to narrow search directory

**Schema:**
```json
{
    "pattern": { "type": "string", "description": "Regex search pattern" },
    "path": { "type": "string", "description": "Directory or file" },
    "include": { "type": "string", "description": "Glob filter, e.g. '*.ts'" }
}
```

### 11.6 glob

Find files by glob pattern, sorted by modification time.

**Schema:**
```json
{
    "pattern": { "type": "string", "description": "Glob pattern, e.g. '*.ts'" },
    "path": { "type": "string", "description": "Directory to search in" }
}
```

### 11.7 ls

List directory contents as a tree (ignores `node_modules`, `.git`, `dist`, etc.).

**Schema:**
```json
{
    "path": { "type": "string" },
    "depth": { "type": "integer", "description": "Max depth (default: 3)" }
}
```

### 11.8 ask

Ask the user a question and wait for their response. Triggers the question UI flow (see 8.12).

**Schema:**
```json
{
    "question": { "type": "string", "description": "Question to ask the user" }
}
```

### 11.9 eval

Execute TypeScript inside the Hal process itself. Has access to runtime internals.

**Features:**
- Code runs in the Hal process (not a subprocess)
- `ctx` object in scope: `{ sessionId, halDir, stateDir, cwd, runtime }`
- Can import modules with `~src/` prefix (resolved to Hal's source directory)
- Scripts are persisted in `eval/<id>.ts` — never deleted (audit trail)
- Return value is serialized and shown as tool output
- Can monkey-patch running code via namespace objects

**Schema:**
```json
{
    "code": { "type": "string", "description": "TypeScript function body" }
}
```

### 11.10 web_search

Search the web for up-to-date information.

**Schema:**
```json
{
    "query": { "type": "string", "description": "Search query" }
}
```

### 11.11 read_blob

Read a stored blob by ID. Used to inspect tool call/result data, thinking blocks, or images.

**Schema:**
```json
{
    "blobId": { "type": "string", "description": "Blob ID to read" }
}
```

### 11.12 Tool Output Streaming

For long-running tools (especially `bash`), output is streamed to the client during execution:
- `tool` event with `phase: 'streaming'` carries incremental output
- Client appends to the existing tool block
- Display updates in real-time (diff engine handles partial updates)
- Final `phase: 'done'` carries the complete output

---

## 12. Phase 9: Context Management

### 12.1 Context Tracking

Each session tracks token usage:
```typescript
{ used: number; max: number; estimated?: boolean }
```

- `used` comes from the provider's response usage stats
- `max` is the model's context window size (looked up from model registry)
- `estimated` flag when usage is interpolated rather than measured

### 12.2 Progressive Pruning

When building API messages from history (`loadApiMessages`), old content is progressively pruned to stay within context limits:

**Prunable content (by age/recency):**
1. **Images** — removed after N user turns (default: 4)
2. **Thinking blocks** — removed after N user turns (default: 6) (thinking signatures removed along with text)
3. **Tool outputs** — truncated to M characters after N user turns (default: 800 chars after 6 turns)
4. **Prompt caching hints** — only on the last few messages

Pruning preserves the **structure** of the conversation (user/assistant/tool_result ordering) — it only reduces content within blocks.

### 12.3 Error Injection

Error and warning events from the history are injected into the next user message as prefixed text:
- `[Error] message` for errors
- `[Warning] message` for warnings
- Only injected if within the TTL (default: 3 user turns from the end)

This allows the model to see and respond to errors from previous turns without storing them as separate API messages.

---

## 13. Phase 10: System Prompt

### 13.1 SYSTEM.md Preprocessor

The system prompt is built from `SYSTEM.md` at the Hal directory root. Before sending to the model, it's preprocessed:

1. **Variable substitution:**
   - Model name (e.g. `anthropic/claude-opus-4-6`)
   - Hal directory path
   - Current date
   - Session ID
   - `${eval}` expressions

2. **Conditional blocks:**
   ```
   ::: if model="claude-*"
   Claude-specific instructions here
   :::
   ```
   Uses glob matching on model name.

3. **HTML comment stripping:** `<!-- ... -->` removed

4. **Blank line collapsing:** Consecutive blank lines → single blank line

### 13.2 AGENTS.md Chain

If an `AGENTS.md` file exists in the session's working directory, its content is appended to the system prompt. This allows per-project instructions.

The chain walks up the directory tree: if the working directory is `/a/b/c` and `AGENTS.md` exists at `/a/b/AGENTS.md`, it's included.

### 13.3 Prompt Caching

For Anthropic, the system prompt is sent with `cache_control: { type: 'ephemeral' }` on strategic blocks. This tells the API to cache the system prompt across calls, reducing input token costs on long conversations.

---

## 14. Phase 11: Startup, Install & Operations

### 14.1 Install Script

Prerequisites that must be installed:
- **Bun** (JavaScript/TypeScript runtime)
- **Homebrew** (on macOS) — for installing system dependencies
- **ripgrep** (`rg`) — required by the `grep` tool (installed via `brew install ripgrep` on macOS)
- Run `bun install` to install npm dependencies

Post-install:
- Symlink `./run` to `~/.local/bin/hal`
- Ensure `~/.local/bin` is in `$PATH`

### 14.2 Init Script (`./init`)

Interactive first-run setup, triggered automatically if `config.ason` doesn't exist:

1. **Provider configuration:**
   - Choose provider (Anthropic / OpenAI)
   - Enter API key or initiate OAuth login (opens browser)
   - Saves to `auth.ason`

2. **Permission level:**
   - YOLO (no confirmation)
   - Ask for write operations
   - Ask for all operations

3. **Default model selection**

### 14.3 Run Script (`./run`)

Shell script entry point with restart loop:

```bash
#!/usr/bin/env bash
# Resolve symlinks (works from ~/.local/bin/hal)
# Export HAL_DIR, LAUNCH_CWD, HAL_STATE_DIR

# Flags:
#   -s, --self    Work on hal itself (cwd=hal_dir, prefer idle low-context tab)
#   -f, --fresh   Start with fresh temp state directory
#   -h, --help    Show help

# First-run: ./init if no config.ason

# Restart loop:
while true; do
    HAL_STARTUP_EPOCH_MS="$(timestamp)" bun src/main.ts "$@"
    code=$?
    [ "$code" -ne 100 ] && exit "$code"
    # Exit 100 = restart requested (ctrl-r)
done
```

**Key details:**
- Symlink resolution: the script follows symlinks to find `HAL_DIR`, so it works when invoked as `~/.local/bin/hal`
- `LAUNCH_CWD` captures the user's directory before `cd`ing to `HAL_DIR`
- `HAL_STARTUP_EPOCH_MS` is set to current timestamp (milliseconds) for performance tracking
- Exit code 100 triggers restart (used by Ctrl-R)
- Any other exit code terminates

### 14.4 Self Mode (`-s` flag)

When launched with `-s` or `--self`:
- Sets `LAUNCH_CWD` to `HAL_DIR` (works on its own codebase)
- Client prefers an idle, low-context-usage tab (to avoid accidentally continuing an expensive conversation)
- If no suitable tab exists, opens a new one

### 14.5 CWD Mode

When launched from a directory that's different from `HAL_DIR`:
- Client looks for an existing tab whose `workingDir` matches `LAUNCH_CWD`
- If found, switches to it
- If not found, opens a new tab with that working directory

### 14.6 Restart & Handoff Semantics

**Ctrl-R restart:**
1. Save current prompt draft
2. Write handoff state (active sessions, busy sessions) to `state.ason`
3. Clean up terminal
4. Exit with code 100 (triggers restart loop in `./run`)
5. New process starts, reads handoff state
6. **Busy sessions auto-continue** — if a session was generating, it resumes
7. **Paused/idle sessions do NOT auto-continue** — preserved but not restarted
8. Active tab is restored (from `client.ason`)

**Host death → client promotion:**
1. Client detects host PID is gone (20ms poll or `[host-released]` event)
2. Client claims host lock
3. Client imports runtime module, restores sessions
4. Same handoff logic: busy sessions continue, idle ones don't
5. **Active tab preserved** — client already has it in `client.ason`

**Critical invariant:** The user's current tab must NEVER change unexpectedly across restarts or promotions. The tab is determined by `client.ason`, not by the runtime's `activeSessionId`.

### 14.7 Graceful Quit

**Ctrl-C quit:**
1. If destructive tools are running (bash, write, edit): show warning, require second Ctrl-C within 5s
2. Write handoff state
3. Release host lock
4. Print message: "If Hal starts within Ns, it will continue from here"
5. Exit

### 14.8 Suspend & Resume

**Ctrl-Z:**
1. Restore terminal to normal mode (disable raw mode, show cursor, disable kitty keyboard protocol)
2. Send `SIGSTOP` to self
3. On `SIGCONT`: re-enable raw mode, re-enable kitty keyboard protocol, full re-render

### 14.9 Debug Logging

`debug.log` in state directory. Structured logging with timestamps. Enabled via environment variable or config.

---

## 15. Phase 12: Testing & Performance

### 15.1 Test Framework

- Tests live alongside code (`*.test.ts`) and in `src/tests/` for e2e
- Parallel test runner (`./test` script, NOT `bun test` which is sequential)
- Type checking: `bunx tsgo --noEmit`

### 15.2 Test Driver

`TestDriver` — lightweight harness for testing TUI prompt/keybinding behavior:
- Type characters into a virtual prompt
- Send key events (enter, backspace, arrows, ctrl+key)
- Assert text content, cursor position, selection state
- No actual terminal needed

### 15.3 Startup Performance Testing

**This must be automated.** Performance regressions are common and must be caught by the test framework.

**Requirements:**
- Collect representative long sessions (real history files with hundreds/thousands of messages)
- Automated tests that restore these sessions and assert startup time
- Startup time budget: <200ms to interactive (target in `startupPerfSample()`)
- Measure and report each phase:
  - `first-code` — first line of TypeScript executed
  - `rt-ipc-ready` — IPC bus initialized
  - `rt-state-loaded` — state.ason read
  - `rt-sessions-restored` — all session metadata loaded
  - `rt-published` — initial state published
  - `runtime-ready` — host runtime fully initialized
  - `cli-ready` — CLI first frame visible
  - `active-messages-loaded` — current tab's history read + parsed
  - `active-tail-hydrated` — tail messages converted to blocks
  - `active-tail-rendered` — first render with content
  - `interactive-ready` — user can type
  - `active-all-hydrated` — background hydration complete
  - `other-tabs-hydrated` — all tabs fully loaded

**Startup trace** is built into the system: `startupTrace.mark(key, detail?)` records timestamps, and `startupTrace.drainLines()` produces formatted lines shown as info blocks in the active tab.

### 15.4 Error Handling

User-facing error approach:
- Errors from the AI provider are formatted as error blocks (red boxes)
- The user sees the error and can press Enter or type to continue
- Error detail is auto-formatted (JSON pretty-printed if present)
- Errors are injected into the next API call context (so the model sees what went wrong)
- No automatic retry for most errors (except rate limits/overload)

---

## 16. Ossified Components

These components are battle-tested and can be carried over with little or no changes:

| Component | File(s) | Why |
|-----------|---------|-----|
| ASON parser/serializer | `utils/ason.ts` | Complete, well-tested, no dependencies |
| Log (append-only ASONL) | `utils/log.ts` | Simple, correct, handles tail/watch |
| Live File | `utils/live-file.ts` | Proxy-based auto-save, file watching |
| Read File Cache | `utils/read-file.ts` | Stat-based cache, caller tracking |
| String utilities | `utils/strings.ts` | visLen, wordWrap, charWidth — foundational |
| IPC bus | `ipc.ts` | File-backed, host election, event/command logs |
| Session persistence | `session/session.ts`, `session/history.ts` | Append-only history, blob storage |
| Fork chains | `session/history-fork.ts` | Recursive fork resolution |
| Blob storage | `session/blob.ts` | Simple ASON files, fork-chain-aware reads |
| Edit tool (hashline) | `tools/edit.ts`, `tools/read.ts` | Hash-verified edits, proven in production |
| Key parser | `cli/keys.ts` | CSI, kitty, paste — comprehensive |
| Block fingerprinting | `cli/block-fingerprint.ts` | FNV-1a hash, fast render cache |
| Diff engine | `cli/diff-engine.ts` | Minimal ANSI diffs, synced output |
| Startup trace | `perf/startup-trace.ts` | Performance instrumentation |
