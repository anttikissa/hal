# TUI Test Harness

## Goal

E2e test that exercises the real input path: `parseKeys → handleInput →
client.onSubmit + prompt.pushHistory`. Must catch bugs like the double-push
(shared array reference between client.inputHistory and prompt.history).

## Problem

`keybindings.ts` imports `client, quit, doRender, ...` directly from `cli.ts`.
`cli.ts` has top-level TTY setup (setRawMode, kitty kbd, etc.) — can't import
it in tests.

## Refactor

**keybindings.ts**: replace the `cli.ts` import with an `init()` function.

```ts
// Before
import { client, quit, restart, suspend, doRender, contentWidth, showError } from '../cli.ts'

// After
let client: Client
let quit: () => void
let restart: () => void
let suspend: () => void
let doRender: () => void
let contentWidth: () => number
let showError: (msg: string) => void

export function initKeybindings(deps: {
    client: Client, quit: () => void, restart: () => void,
    suspend: () => void, doRender: () => void,
    contentWidth: () => number, showError: (msg: string) => void,
}): void {
    client = deps.client; quit = deps.quit; ...
}
```

**cli.ts**: calls `initKeybindings(...)` with real implementations. One line.

Cost: ~12 lines added to keybindings.ts, +1 to cli.ts. No behavior change.

## Harness

`src/test-harness-tui.ts` (~50 LOC):

- Creates a real `Client` with a NullTransport (interface impl, 5 methods
  returning empty data — not a mock, just a minimal transport).
- Calls `initKeybindings({ client, quit: ..., doRender: noop, contentWidth: () => 80, ... })`
- Manually creates one tab on the client with an inputHistory array.
- Reads raw stdin → `parseKeys()` → `handleInput(k)` — the REAL function.
- After each key, emits ASONL: `{ type: 'prompt', text: '...', cursor: N }`
- On submit (detected via the real handleInput enter path), emits `{ type: 'submit', text: '...' }`

The `Client` needs a tab to exist so `onSubmit` can push to `inputHistory`
and `applyTabToPrompt` can call `setHistory(tab.inputHistory)`. The harness
calls `client.start()` which bootstraps from the NullTransport (returns one
empty session), then the client creates a tab and wires up history.

Wait — `client.start()` does async replay + IPC tailing. Too heavy.
Instead, expose a lighter setup: add a `static createForTest(...)` or just
manually set up the client state. Actually, `Client` already has a
constructor that takes transport + onUpdate. We can:

1. Subclass or just call the constructor with NullTransport.
2. Manually push a tab into the state.

But `state` is private. Options:
- Make it package-accessible (no private in TS anyway at runtime).
- Add a `addTab(info)` method.
- Just have the NullTransport's `bootstrap()` return one session.

**Simplest**: NullTransport.bootstrap() returns one fake session. Then
`client.start()` works — it creates the tab from bootstrap data, calls
`loadInputHistory` (returns []), calls `loadDraft` (returns ''). BUT
`client.start()` also tails events forever (async generator).

Fix: NullTransport.tailEvents returns an async generator that never yields.
Then start() enters the for-await but doesn't block because we handle stdin
in parallel.

Actually `start()` does `for await (const event of ...)` which blocks
forever. The harness needs stdin processing to happen concurrently.
Just call `client.start()` without awaiting — it runs in background.

## Missing piece

`prompt.ts` needs to export cursor position:
```ts
export function cursorPos(): number { return cursor }
```

## Detecting state changes

The harness needs to know when prompt state changes. `doRender` is called by
`handleInput` after every key. The harness's `doRender` implementation emits
the current prompt state as ASONL.

```ts
function doRender(): void {
    emit({ type: 'prompt', text: prompt.text(), cursor: prompt.cursorPos() })
}
```

## NullTransport

```ts
const nullTransport: Transport = {
    async sendCommand() {},
    async bootstrap() {
        return {
            state: { sessions: ['test'], activeSessionId: 'test', busySessionIds: [] },
            sessions: [{ id: 'test', workingDir: '.', createdAt: '', updatedAt: '' }],
        }
    },
    tailEvents() {
        return { items: (async function*() { yield* [] })(), cancel() {} }
    },
    async replaySession() { return [] },
    async eventsOffset() { return 0 },
}
```

~12 lines.

## Test file

`src/tests/prompt-history.test.ts` (~70 LOC):

1. Spawn `bun src/test-harness-tui.ts` with `HAL_STATE_DIR` pointing to a temp dir
2. Wait for `{ type: 'ready' }`
3. Type 'foo' + enter, 'bar' + enter, 'zot' + enter
4. Press up → assert text is 'zot'
5. Press up → assert text is 'bar'
6. Press up → assert text is 'foo'
7. Press down → assert text is 'bar'
8. Press down → assert text is 'zot'
9. Press down → assert text is '' (draft)

Uses ASONL parsing (ason.parse per line).

## Line count

| File | Lines |
|------|-------|
| keybindings.ts (refactor) | +12 |
| cli.ts (init call) | +2 |
| prompt.ts (export cursor) | +1 |
| test-harness-tui.ts | ~50 |
| tests/prompt-history.test.ts | ~70 |
| **Total** | **~135** |
