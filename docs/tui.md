# TUI Rendering & Input Model

## Scope

The CLI TUI is spread across modules in `src/cli/`. This document is the umbrella mental-model doc.

Keep this document up to date when changing TUI behavior in any of these files.

## TUI Module Family (Who Owns What)

- `src/cli/client.ts`
  - orchestration: transport wiring, event handling, tab lifecycle, command dispatch
- `src/cli/blocks.ts`
  - block-based content model for tab output (`Block` type, `renderBlocks`)
- `src/cli/diff-engine.ts`
  - diff-rendered terminal output: compares old/new screen lines, emits minimal escape sequences
- `src/cli/prompt.ts`
  - prompt area: state, key handling, line building
- `src/cli/input.ts`
  - input area model: word wrapping, cursor ↔ row/col mapping, vertical movement
- `src/cli/keys.ts`
  - terminal input normalizer: raw stdin bytes → structured `KeyEvent`
- `src/cli/keybindings.ts`
  - key → action mapping (imports from modules that own each function)
- `src/cli/tabs.ts`
  - tab state and management
- `src/cli/tabline.ts`
  - tabline compaction/fallback rendering (`full` → `[1x]` → `1x` → `123...`)
- `src/cli/md.ts`
  - mini markdown → ANSI for LLM output (fences, tables, inline formatting)
- `src/cli/colors.ts`
  - centralized color definitions
- `src/cli/cursor.ts`
  - blinking block cursor at active output positions
- `src/cli/heights.ts`
  - tab height calculations
- `src/cli/clipboard.ts`
  - clipboard access (macOS only), paste handling
- `src/cli/transport.ts`
  - transport interface + local (file-backed) IPC implementation

## Layout (Mental Model)

The TUI uses a **diff-rendered** approach via `diff-engine.ts`.

- Row 1: **Title bar**
- Rows `2..outputBottom`: **Output** (scrollable, block-based)
- Footer:
  - **Activity bar**
  - **Tab bar / status bar**
  - **Input** lines

Tabline behavior:
- Preferred form: active tab as `[N topic]`, inactive as ` N topic `.
- If width overflows, fallback modes are applied in order:
  1. `[Nx] [N ] ...`
  2. `Nx N ...`
  3. `123...`
- Tabline is hard-clipped to terminal width; it must never wrap.
- Session ID moved to the status separator line (right side).

Content is modeled as `Block[]` per tab (`src/cli/blocks.ts`). Blocks are rendered into screen lines by `renderBlocks()`.

## Core State

- **Tabs** (`src/cli/tabs.ts`): per-tab blocks, drafts, history, scroll position
- **Prompt** (`src/cli/prompt.ts`): input buffer, cursor, selection, undo stack
- **Screen** (`src/cli/diff-engine.ts`): previous frame for diffing

## Input Pipeline (Bytes → KeyEvent → Action)

### 1. Raw stdin

Raw bytes from `process.stdin` in raw mode.

### 2. Parse to KeyEvent (`src/cli/keys.ts`)

`parseKey()` / `parseKeys()` splits raw bytes into structured `KeyEvent` objects with:
- `key`: normalized key name (e.g. `'a'`, `'Enter'`, `'ArrowUp'`)
- `ctrl`, `alt`, `shift`, `super`: modifier flags
- `raw`: original bytes

Handles all terminal key families:
- Legacy single-byte controls (`Ctrl-C` = `\x03`)
- Legacy CSI / SS3 functional keys (`\x1b[A`, `\x1b[H`)
- xterm modified keys (`\x1b[1;3D`)
- Kitty/Ghostty `CSI u` protocol (`\x1b[97u`, `\x1b[97;5u`)
- Kitty release/repeat events (suppressed)
- Bracketed paste
- Mouse reports

### 3. Key → Action (`src/cli/keybindings.ts`)

Maps `KeyEvent` to actions. Client installs handlers for app-level keys (tab create/close/fork/switch). Remaining keys go to prompt editing.

Tab completion behavior:
- `Tab` completes slash commands and known arguments.
- Includes command names, model aliases/full IDs, session IDs (`/resume`/`/open`), and `/respond skip`.
- Multiple matches write one info line into output with candidate values.

### 4. Prompt editing (`src/cli/prompt.ts`)

Handles:
- Text insertion
- Cursor movement, word movement
- Selection (shift+movement)
- Clipboard (cut/copy/paste)
- History navigation
- Submit (Enter) / newline (Shift+Enter, Alt+Enter)
- Undo

## Rendering Model

### Block-Based Output

Output is stored as `Block[]` per tab. Block types include input prompts, assistant text, tool output, status lines, etc. `renderBlocks()` converts blocks to wrapped screen lines.

Current block rendering rules:
- Block lines are rendered inside a 1-column outer margin on both sides.
- Thinking text under 5 wrapped lines is shown as plain dim lines.
- Thinking text at 5+ lines renders as a block with header `── Hal (<model>, thinking) ...` and collapses after 10 lines with `[+ n lines]`.
- Bash tool headers:
  - short command: `bash: <cmd> (<time>) ✓|✗|…`
  - long command (>60 chars): header omits command; command is shown on wrapped body lines using trailing `\` continuations.
- Tool error status is rendered as error (`✗`) and persisted in block result metadata.

### Diff Rendering

`src/cli/diff-engine.ts` compares the previous frame with the new frame and emits minimal escape sequences — both line-level (skip unchanged, clear removed) and intra-line (rewrite only changed substrings).

On kitty/ghostty-compatible TTYs, frames are wrapped in synchronized output (`\x1b[?2026h` ... `\x1b[?2026l`) to avoid flicker.

## Mouse / Link Behavior

Features:
- Output scrolling (wheel)
- Screen selection (single/double/triple click → char/word/line)
- Click-to-open links
- Cmd/Super-gated hover underline for links

## Terminal Modes & Lifecycle

### Startup

- Enter raw mode
- Enter alternate screen (`?1049h`)
- Enable mouse + bracketed paste (+ Kitty keyboard mode on supported terminals)
- Attach stdin/resize/SIGCONT listeners

### Suspend (`Ctrl-Z`)

- Disable terminal modes, leave alt screen
- Dump visible output to main screen
- Disable raw mode, send `SIGSTOP`
- `SIGCONT` restores everything and re-renders

### Cleanup

- Stop timers, show cursor
- Disable mouse/paste/Kitty keyboard modes
- Leave alt screen, disable raw mode
- Dump visible output to scrollback

## Key Documentation Contract (For Future Changes)

When adding or changing key support, document:

1. Logical key/action
2. Raw encodings observed
3. Owning layer (parser vs keybindings vs prompt)
4. Normalized `KeyEvent` form
5. Event policy (press only vs press+repeat vs release ignored)
6. Test coverage

## Key Debug Workflow

1. Capture raw sequence (`bun test.ts` or `/bug`)
2. Classify sequence family (CSI u, legacy CSI, etc.)
3. Check parser (`parseKey` in `keys.ts`)
4. Check keybinding mapping
5. Check prompt handler
6. Add tests

## Lessons / Pitfalls

- Diff engine assumes consistent column width — `charWidth()` in `md.ts` handles wide characters.
- Synchronized output wrapping prevents mid-frame flicker. If adding another frame write path, use the same sync wrapper.
