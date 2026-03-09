# Extract input handler from cli.ts

## Problem

cli.ts mixes rendering, terminal setup, and input handling in one 230-line file. The input handler (lines 164-216) should be its own module.

## What the input handler does

Maps `KeyEvent` → side effects:
- `ctrl-c` → quit
- `ctrl-w` / `ctrl-d` (empty) → close tab or quit if last
- `ctrl-t` → open tab
- `ctrl-n/p` → switch tabs
- `ctrl-z` → suspend
- `ctrl-r` → restart (exit 100)
- `ctrl-k` → simulated crash
- `enter` → submit prompt
- everything else → prompt.handleKey

## What it needs (the context)

```ts
interface InputContext {
    quit(): void
    restart(): void
    suspend(): void
    render(): void
    resetContentHighWater(): void

    // Prompt
    promptText(): string
    promptReset(): void
    promptHandleKey(k: KeyEvent, width: number): boolean

    // Client
    send(cmd: string, text?: string): void
    tabCount(): number
    nextTab(): void
    prevTab(): void

    // IPC
    clearSessions(): void

    // Layout
    contentWidth(): number
}
```

## New file: `cli/input-handler.ts`

Single function:
```ts
export function handleInput(k: KeyEvent, ctx: InputContext): void
```

## cli.ts changes

- Create the `InputContext` object from existing locals
- Replace `stdin.on('data', ...)` body with `handleInput(parseKey(data), ctx)`
- Remove the inline key handling block

## What stays in cli.ts

- Terminal setup (raw mode, kitty)
- Renderer (buildLines, doRender)
- quit(), restart(), suspend() definitions
- The InputContext wiring
