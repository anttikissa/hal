# TUI Rendering & Input Model

## Scope

`src/cli/tui.ts` is the terminal UI engine used by the CLI client.
This document is the umbrella mental-model doc for the TUI module family in `src/cli/tui*.ts`.

Core logic: `src/cli/tui.ts`.

Keep this document up to date when changing TUI behavior in any of these files:

- `src/cli/tui.ts`
- `src/cli/tui-text.ts`
- `src/cli/tui-input-layout.ts`
- `src/cli/tui-links.ts`

If a change affects rendering, input parsing/tokenization, key normalization, input layout mapping, link hit-testing, terminal modes, or the TUI public API, update this doc in the same commit as the code change.

It is a single stateful module (module-level mutable state, no classes) that owns:

- alternate-screen rendering
- input line editing
- output scrolling/wrapping
- mouse selection + link hover/click support
- terminal mode management (mouse, bracketed paste, Kitty keyboard protocol)

It does **not** own app-level behavior like tabs/sessions/commands. `src/cli/client.ts` wires those in via callbacks (`setInputKeyHandler`, `setTabCompleter`, etc).

## TUI Module Family (Who Owns What)

- `src/cli/tui.ts`
  - orchestration: state, render loop, key handling, mouse handling, lifecycle
- `src/cli/tui-text.ts`
  - ANSI-aware wrapping/truncation and key tokenization (`parseKeys`)
- `src/cli/tui-input-layout.ts`
  - wrapped input cursor/row/col mapping
- `src/cli/tui-links.ts`
  - OSC-8 parsing, URL linkification, hit-testing, hover underline helpers
- `src/cli/tui-text.test.ts`
  - tests for text/wrapping/tokenization helper behavior

## Layout (Mental Model)

The TUI is a **state-driven full redraw renderer**.

- Row 1: **Title bar**
- Rows `2..outputBottom()`: **Output** (scrollable, wrapped)
- Footer:
  - **Activity bar**
  - **Tab bar / status bar**
  - input top pad
  - **Input** lines (1..`maxPromptLines`)
  - input bottom pad

`render()` redraws every row from current state. There is no diffing/patching layer.

This is the core model to keep in mind: mutate module state -> call `render()` (or `scheduleRender()` for batched cosmetic updates).

For the `new/` diff-rendered CLI, a streaming inline cursor may only stay on the same rendered line if that line still has spare visible width. If the last rendered line already fills the target width, the cursor must be rendered on a following line instead of overflowing into an implicit terminal wrap row.

## Core State Buckets

`src/cli/tui.ts` keeps several independent state groups:

- Lifecycle:
  - `initialized`, `ended`, `suspended`
- Output buffer / viewport:
  - `outputLines` (logical, unwrapped lines with ANSI)
  - `scrollOffset`
  - wrap cache (`wrappedLineCount`, `lastWrapCols`)
- Header/footer display:
  - `titleBarStr`, `activityStr`, `statusTabsStr`, `statusRightStr`
  - transient `headerFlash`
- Input editor:
  - `inputBuf`, `inputCursor`, `inputPromptStr`
  - input text selection (`inputSel*`)
  - undo stack (`inputUndoStack`)
  - pending `input()` resolver (`waitingResolve`)
- Screen selection (mouse):
  - `selAnchor`, `selCurrent`, `selMode`, `selActive`
  - click-count tracking for char/word/line selection
- Output/link hover:
  - `lastVisibleOutput`, `lastActivityLine`, `lastStatusLine`
  - `hoverUrl`, `hoverOutputRow`, `superHeld`
- Stdin/paste buffering:
  - `bracketedPasteBuffer`
  - `stdinBuffer` + coalescing timer

Important distinction:

- `outputLines` is the source of truth for output text.
- `lastVisibleOutput` is only the most recent rendered viewport snapshot (used for mouse selection/hit testing).

## Rendering Model

### Output Storage

Output is appended via `write()` -> `writeToOutput()` -> `appendOutput(...)`.

- `outputLines` stores **logical** lines, not wrapped rows.
- ANSI escapes are preserved in storage.
- `\r` resets the current logical line (used for streaming/progress updates).
- Output is capped to `MAX_OUTPUT_LINES`.

### Wrapping & Viewport

Wrapping is computed on demand:

- `wrapAnsi(...)` preserves ANSI state and OSC-8 links across wraps
- `getTotalVisualLines()` caches total wrapped rows by terminal width
- `getVisibleWrapped(...)` builds only the visible window (plus scroll offset slack) by walking backward from the tail

The **Output** region is therefore:

- stored as logical lines
- rendered as wrapped visual rows
- recalculated when terminal width changes or output changes

### Full Redraw

`render()`:

- recomputes viewport geometry
- clamps scroll offset
- renders title/output/activity/tab/input rows into a string chunk array
- writes one combined ANSI frame to stdout
- on kitty/ghostty-compatible TTYs, wraps each frame in synchronized output mode (`\x1b[?2026h` ... `\x1b[?2026l`) to avoid mid-frame flicker
- positions cursor for input editing

`scheduleRender()` is used for microtask-batched redraws when immediate redraw is not necessary.

## Input Pipeline (Bytes -> Text/Edit)

This is the most important mental model for keyboard bugs.

### 1. Raw stdin event

`onStdinData(...)` receives chunks from `process.stdin` in raw mode.

It first handles special streams:

- bracketed paste accumulation (`\x1b[200~` .. `\x1b[201~`)
- mouse events (`CSI < ... M/m`) processed immediately

Everything else is coalesced briefly (`STDIN_COALESCE_MS`) into `stdinBuffer`.

### 2. Tokenize to key units

`flushStdinBuffer()` calls:

- `parseKeys(data, PASTE_START, PASTE_END)` from `src/cli/tui-text.ts`

This splits the raw text into key/event tokens (single chars, CSI sequences, paste payloads, etc).

### 3. Normalize terminal-specific key formats

Each token goes through `handleKey(...)`, which first calls:

- `normalizeKittyKey(...)`

This handles Kitty/Ghostty keyboard protocol (`CSI u` and enhanced functional key forms):

- strips/suppresses release events
- normalizes many keys back to legacy forms
- preserves Super/Cmd combos as `CSI u` for higher-level handlers that need them
- tracks Super press/release for Cmd+hover link behavior

This normalization layer is where terminal-specific regressions usually happen.

### 4. App-level override hook (tabs, etc)

After normalization, `handleKey(...)` calls optional `inputKeyHandler`.

`src/cli/client.ts` installs this to intercept app commands such as:

- tab create/close/fork
- tab switching shortcuts

If it returns truthy, TUI input editing stops for that key.

### 5. TUI built-in editing/submit behavior

If not intercepted, `handleKey(...)` processes:

- `Ctrl-C`, `Ctrl-D`, `Ctrl-Z`
- clipboard shortcuts (including Kitty/xterm modifier encodings)
- Enter / double-enter
- cursor movement, word movement, history navigation
- selection-aware editing (cut/copy/paste/delete)
- scrolling shortcuts
- tab completion
- text insertion fallback

Unknown escape sequences are dropped intentionally.

## Keyboard Model (What To Document, Where)

Keyboard handling in HAL has three layers. Bugs usually come from changing the wrong one.

### Layer A: Tokenization (`src/cli/tui-text.ts`)

Responsibility:

- split a raw stdin chunk into event/key tokens
- preserve escape sequence boundaries
- not interpret key meaning

Examples of tokens emitted by `parseKeys(...)`:

- plain character (`a`)
- legacy escape sequence (`\x1b[A`)
- xterm modified key (`\x1b[27;5;119~`)
- Kitty `CSI u` (`\x1b[97u`, `\x1b[97;1:3u`, `\x1b[97;;97u`)
- bracketed paste payload

If tokenization is wrong:

- keys may be split/merged incorrectly
- downstream normalization cannot recover

### Layer B: Normalization (`src/cli/tui.ts`)

Responsibility:

- convert terminal-specific encodings into HAL's internal key forms
- suppress events HAL intentionally ignores (for example key release)
- preserve encodings only when higher-level handlers need raw modifier detail

Current normalization entrypoint:

- `normalizeKittyKey(...)`

Key invariant:

- printable text should usually reach insertion path as plain characters
- common navigation/edit keys should usually become legacy CSI/bytes
- only special cases (for example Super/Cmd combos) should remain as raw `CSI u`

### Layer C: Key Semantics (`src/cli/tui.ts` + `src/cli/client.ts`)

Responsibility:

- assign behavior to normalized keys
- choose precedence/order of handlers
- mutate TUI/app state

Examples:

- `src/cli/client.ts`: tab shortcuts (`Ctrl-W`, `Ctrl-T`, `Ctrl-F`, tab switching)
- `src/cli/tui.ts`: input editing, history, submit, scrolling, clipboard shortcuts

## Key Sequence Families (Reference)

When documenting or debugging a key, always identify the sequence family first.

- Legacy single-byte controls:
  - `Ctrl-C` (`\x03`), `Ctrl-D` (`\x04`), `Tab` (`\t`), `Enter` (`\r`)
- Legacy CSI / SS3 functional keys:
  - arrows/home/end/page keys like `\x1b[A`, `\x1b[H`, `\x1b[5~`, `\x1bOA`
- xterm `modifyOtherKeys` / modified functional keys:
  - forms like `\x1b[27;...~`, `\x1b[1;3D`
- Kitty/Ghostty keyboard protocol `CSI u`:
  - text and modified keys like `\x1b[97u`, `\x1b[97;5u`
  - release/repeat variants like `\x1b[97;1:3u`
  - compact/extended variants like `\x1b[97;;97u`
- Kitty-enhanced functional keys (non-`CSI u`):
  - event type encoded in modifier field, e.g. `\x1b[1;1:2A`
- Mouse reports:
  - `\x1b[<...M` / `\x1b[<...m`
- Bracketed paste:
  - `\x1b[200~ ... \x1b[201~`

This classification is more useful than terminal name (`kitty`, `ghostty`, `iterm`) when debugging.

## Key Documentation Contract (For Future Changes)

When adding or changing key support, document the change in terms of:

1. Logical key/action
   - Example: “normal text insertion”, “Cmd-V in Kitty”, “Shift+Enter newline”
2. Raw encodings observed
   - Include exact sequences from `test.ts` or debug logs
3. Owning layer
   - Tokenizer vs normalizer vs handler
4. Normalized form used by HAL
   - Example: plain `'a'`, `'\x1b[D'`, preserved `CSI u`
5. Event policy
   - press only vs press+repeat vs release ignored
6. Test coverage
   - where the regression should be locked down

Practical rule:

- If a fix only adds another ad hoc regex in a handler, it is probably in the wrong layer.

## Key Debug Workflow (Repeatable)

Use this sequence when a terminal-specific key bug appears:

1. Capture raw sequence
   - `bun test.ts` (or `/bug` with keypress logging enabled)
2. Classify sequence family
   - `CSI u`, legacy CSI, modifyOtherKeys, mouse, paste
3. Check tokenizer boundary
   - ensure `parseKeys(...)` emits one token for the event
4. Check normalization
   - verify terminal-specific sequence becomes HAL's expected internal form
5. Check handler precedence
   - app hook vs TUI handler vs insertion fallback
6. Add/adjust docs and tests
   - avoid “fix by memory” regressions

## Input Editor Semantics

### `input(promptStr)`

`input()` is the main prompt primitive:

- initializes TUI on first use
- resets input buffer/cursor/selection/undo
- renders prompt
- returns a Promise resolved by Enter / Ctrl-C / Ctrl-D / cancel

Resolution values:

- normal submit -> `string`
- EOF/cancel/end -> `null`
- waiting `Ctrl-C` -> exported `CTRL_C` sentinel (`'\x03'`)

### History & Drafts

The module owns input history and current draft state, exposed via:

- `getInputHistory()` / `setInputHistory(...)`
- `getInputDraft()` / `setInputDraft(...)`

This lets the CLI client preserve per-tab drafts/history while the TUI remains session-agnostic.

### Input vs Screen Selection

There are two separate selection systems:

- **Input text selection**: operates on `inputBuf` indices
- **Screen selection**: operates on rendered row/col positions across output/activity/status surfaces

They are intentionally separate because one is text-model based and the other is screen-space based.

## Mouse / Link Behavior

Mouse mode is enabled in `enableMouse()` and disabled in `disableMouse()`.

Features handled in `src/cli/tui.ts`:

- output scrolling (wheel)
- screen selection (single/double/triple click -> char/word/line)
- input drag selection
- click-to-open links (via `tui-links.ts`)
- Cmd/Super-gated hover underline for links

Selection is cleared on most non-mouse keypresses and on new output (positions become stale).

## Terminal Modes & Lifecycle

### `init()`

On startup:

- enter raw mode
- enter alternate screen (`?1049h`)
- enable mouse + bracketed paste (+ Kitty keyboard mode on supported terminals)
- attach stdin/end/resize/SIGCONT listeners
- render

### Suspend (`Ctrl-Z`)

`suspendForegroundJob()`:

- disables terminal modes
- leaves alt screen
- dumps visible output to main screen
- disables raw mode
- sends `SIGSTOP`

`onSigCont()` restores raw mode, alt screen, terminal modes, and re-renders.

### `cleanup()`

On exit:

- stop timers / clear transient state
- capture visible output
- show cursor
- disable mouse/paste/Kitty keyboard modes
- leave alt screen
- disable raw mode and remove listeners
- dump visible output to scrollback
- resolve pending `input()` as `null`

This cleanup contract is important: callers can assume terminal state is restored even if a prompt is pending.

## Public API (What Other Modules Use)

Main integration points from `src/cli/client.ts`:

- callback hooks:
  - `setTabCompleter(...)`
  - `setInputKeyHandler(...)`
  - `setInputEchoFilter(...)`
  - `setEscHandler(...)`
  - `setDoubleEnterHandler(...)`
- prompt/input:
  - `input(...)`
  - `prompt(...)`
  - `cancelInput()`
- output/header/footer:
  - `write(...)`, `log(...)`
  - `setTitleBar(...)`, `setActivityLine(...)`, `setStatusLine(...)`
  - `flashHeader(...)`
- snapshot/state transfer (used for tab switching):
  - `getOutputSnapshot()`, `setOutputSnapshot(...)`, `replaceOutput(...)`, `clearOutput()`
  - `getInputDraft()`, `setInputDraft(...)`
  - `getInputHistory()`, `setInputHistory(...)`
- lifecycle:
  - `init()`, `cleanup()`

## Debugging Notes (Useful Mental Shortcuts)

- “Typed text does nothing, but some Ctrl keys work”:
  - check Kitty/Ghostty key normalization (`normalizeKittyKey`, `parseKittyCsiUKey`)
- “Selection highlight looks wrong after output arrived”:
  - screen selection uses rendered coordinates and is cleared on new output
- “Scroll jumps on resize”:
  - see resize path; it preserves viewport center proportion, not exact row index
- “Key works in iTerm but not Kitty/Ghostty”:
  - inspect `supportsKittyKeyboard()` and Kitty `CSI u` parsing/normalization


## Lessons / Pitfalls

- `truncateAnsi()` appends `RESET` (`\x1b[0m`) internally. If you rely on the current background color after truncation (e.g. for `\x1b[K` erase-to-EOL), you must re-apply the background *after* the truncated string. Pattern: `truncateAnsi(line, c) + BG + ERASE_TO_EOL + RESET`.

Related helpers:

- `src/cli/tui-text.ts` -- ANSI-aware wrapping/truncation + key tokenization
- `src/cli/tui-input-layout.ts` -- wrapped input cursor mapping
- `src/cli/tui-links.ts` -- OSC-8 link parsing/hit testing/underline
