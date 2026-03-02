# HAL

Small, fast, zero-dependency coding agent.

## Core goals

- Be small: minimal architecture, minimal moving parts.
- Be fast: quick startup, fast feedback, low-latency TUI.
- Be dependency-free at runtime: Bun + standard library + local code only.
- Be useful: strong coding workflow (tools, sessions, handoff, tabs).
- Be operable: clear logs, reproducible behavior, practical tests.

## Product stance

HAL is not trying to be a giant framework.

HAL should feel like a sharp terminal tool:

- predictable
- keyboard-first
- easy to debug
- easy to extend without bloat

## Implementation principles

- Prefer simple data flow over abstraction layers.
- Keep state file-backed and inspectable.
- Add features only when they improve real task completion.
- Bias toward TUI quality and command ergonomics.
- Keep advanced functionality optional and lightweight.

## Testing policy

- After normal changes: run `bun run test:quick`.
- After big changes: run `bun test`.
- E2e only when needed: run `bun run test:e2e`.
