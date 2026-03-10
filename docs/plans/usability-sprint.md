# Usability Sprint Plan

## 1. Tab restore on restart

**Goal**: When restarting, return to whichever tab was last visible.

**Current state**: 
- `runtime.ts` saves `activeSessionId` to `state/ipc/state.ason` on every publish.
- On restart, `client.ts` reads `rtState.activeSessionId` to set initial tab.
- But this is the *runtime's* active session — not necessarily what the user was looking at.
- Client could have switched tabs locally without the server knowing.

**Plan**:
- Add `state/client.ason` — client-side persistent state, loaded via `liveFile`.
- Structure: `{ servers: { "ipc:~/.hal/state": { lastTab: "02-gcp" } } }`
- On tab switch, client saves `lastTab` to this file.
- On startup (`Client.start()`), after bootstrap, prefer `lastTab` over `rtState.activeSessionId`.
- Server URL is `ipc:${STATE_DIR}` for now (future: `https://hal.kissa.dev` etc).

**Files to edit**:
- New: `src/cli/client-state.ts` (liveFile-backed `{ servers: Record<string, { lastTab: string }> }`)
- `src/cli/client.ts` — on tab switch, persist; on start, read
- `src/state.ts` — add `CLIENT_STATE_PATH`

## 2. Tab appearance

**Goal**: Better tab bar with busy indicators.

**Format**:
- Active: `[1▪.hal]` — bright white (`\x1b[97m`), `▪` = filled square (blinks when busy, space when idle)
- Inactive: ` 2▪.hal ` — dim (245), same format but with spaces instead of brackets
- The `▪` between number and title blinks in sync with the HAL cursor when tab is busy
- When not busy, `▪` is replaced by a space

**Tab name**: 
- Max 12 chars, use `…` for truncation
- Use `topic ?? workingDir.split('/').pop() ?? 'tab'` as title

**Degradation when tabs don't fit** (max 15 tabs):
1. Full: `[1▪.hal]  2 project  3 work ` (active in brackets, inactive with spaces)
2. Short names: truncate titles to 8, then 4 chars
3. Numbers only with busy: `[1▪]  2  3▪ `
4. Just numbers: `1 2 3 4`

**Blink sync**: Use `halCursorVisible` from `cli.ts` blink timer. Pass it through to tabline renderer.

**Files to edit**:
- `src/cli/tabline.ts` — rewrite rendering with colors + busy indicators
- `src/cli/tabline.test.ts` — update tests
- `src/cli.ts` — pass `halCursorVisible` to tabline, apply colors

## 3. ./init script

**Goal**: Interactive first-run setup for providers and permissions.

**Flow**:
1. `./run` checks if `config.ason` exists; if not, runs `./init` first
2. `./init` is a shell script that runs `bun scripts/init.ts`
3. `scripts/init.ts`:
   - Check env for `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`
   - Ask which providers to set up (offer auto-detected ones)
   - For each: use env key, or let user provide key, or login via oauth
   - Ask permission level: 1) YOLO, 2) Ask for writes, 3) Ask for everything
   - Write `config.ason` and `auth.ason` via liveFile
   - Support setting up multiple providers

**Files to create**:
- `init` (shell script)
- `scripts/init.ts`

**Files to edit**:
- `run` — add init check before main loop

## 4. Permission system

**Goal**: Basic permission gating for tool execution.

**Levels**:
1. `yolo` — no confirmation needed
2. `ask-writes` — confirm: write, edit, bash
3. `ask-all` — confirm: everything including read, grep, ls

**Implementation**:
- Add `permissions: 'yolo' | 'ask-writes' | 'ask-all'` to config.ason
- In `runtime/agent-loop.ts`, before executing a tool, check permission level
- If confirmation needed, use `askUser()` to ask "Allow [tool] [args]? (y/n)"
- Cache "allow" decisions for the session (so repeated reads don't re-ask)

**Files to edit**:
- `src/config.ts` — add `permissions` field
- `src/runtime/agent-loop.ts` — add permission check before tool exec

## 5. Question tool UX

**Goal**: Render question as a tool-like box above tab line, not inline.

**Current**: Question label shown as dim separator, answer input below, frozen main prompt.

**New design**:
- Question box renders in the content area as the last block (above tab bar)
- Bright yellow color scheme
- Header: `── Hal is asking you a question ──` in yellow
- Body: question text in HAL color (assistant fg)
- Below that: prompt editing area in normal color (like regular prompt input)
- Main prompt stays frozen/grayed below the separator

**Implementation**: The question box is already positioned above the tab line. We need to:
- Change the color to bright yellow
- Use tool-like box rendering (header + body)
- Make the header text "Hal is asking you a question"
- Show question text in assistant color inside the box

**Files to edit**:
- `src/cli.ts` — update question area rendering in `buildLines()`
- `src/cli/colors.ts` — add question color scheme

## 6. Help bar (last)

**Goal**: Context-sensitive help that learns which shortcuts user knows.

**Design**:
- Help text changes based on context (idle/busy, empty/non-empty input, question mode)
- Track key usage counts in `state/key-usage.ason`
- After 5 uses of a shortcut, hide its help hint
- Config in `config.ason` to skip known shortcuts

**Contexts**:
- Empty input, idle: `enter send │ ctrl-t new │ /help commands`
- Non-empty input, idle: `enter send │ shift-enter newline │ esc clear`
- Busy: `esc pause │ ctrl-t new in background`
- Question: `enter answer │ esc dismiss`

**Files to create/edit**:
- `src/cli/help.ts` — context-sensitive help text generation
- `src/state.ts` — add KEY_USAGE_PATH
- `src/cli/keybindings.ts` — track key usage
- `src/cli.ts` — use help.ts for bottom bar

## Order of implementation

1. Tab appearance (item 2) — most visible, foundational
2. Tab restore (item 1) — quick win
3. Question tool UX (item 5) — improves existing feature
4. Init script (item 3) — setup flow
5. Permission system (item 4) — works with init
6. Help bar (item 6) — polish, last
