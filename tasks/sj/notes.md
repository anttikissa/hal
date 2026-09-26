# State after sj (2026-09-26)

Notes from the coordinator after the first full pass over the task
graph (b … sj), for whoever plans next.

## Functional state

- Works for real: `./run` talks to Opus over the copied OAuth
  credentials (after the user refreshed them), streams thinking and
  text, and the model uses the `read` tool on its own ("Can you read
  tsconfig.json" → tool call → answer). A second `./run` follows the
  same stream; killing the host hands over to it.
- Escape cancels; Ctrl-R restarts into the same conversation; Ctrl-C
  quits leaving the last frame on screen.
- One session per process (newest on disk). No commands, tabs,
  colours, markdown, system prompt, or cwd in the model context.

## Known bugs and surprises

- `[interrupted]` only appears when the *host* process exits while a
  turn is still streaming. Quitting a client leaves the turn running on
  the host. An answer can look finished on screen while the stream has
  not ended yet (message_stop pending), so Ctrl-C then marks it
  interrupted; a moment later it would not. Users see this as random.
- A turn interrupted before any output leaves two user records in a
  row. Replay merges them into one message whose text blocks the model
  reads joined without a separator ("hello wolrd" + "yo" was answered
  as "hello wolrdyo"), and nothing tells the model the earlier turn was
  interrupted. Replay should keep them apart or mark the interruption.
- cacheRead is always 0 in real sessions so far; the prompts were
  small (1–3k tokens), possibly under the cacheable minimum. Check once
  a system prompt exists.
- flock goes through bun:ffi (macOS and Linux only).

## Tests

- 338 tests, ~5,300 test lines for ~4,300 source lines. `./test` is
  green (tsc clean, 4 old oxlint warnings).
- Strong: fake Anthropic and OpenAI-compatible servers, a fake terminal
  emulator with scrollback, real multi-process host takeover with
  kill -9 (5 processes), restart mid-turn and mid-tool-round e2e tests,
  ASON exact-output contracts, credential refresh against a fake
  endpoint.
- Weak or near-tautological, candidates to delete or sharpen:
  "parseModelId splits on the first slash only" (restates a one-liner),
  "restart and quit use different exit codes", "init is idempotent"
  (terminal), "display abbreviates the user home", and the
  conventions test that checks its own rule function.
- Not covered: real TTY behaviour beyond one manual expect run
  (tasks/b3/manual-check.md), suspend in a real terminal, real
  provider contracts (only fakes).

## Process

- 21 tasks, one fresh subagent each, up to four in parallel; 42
  minutes wall clock (00:17–00:59).
- Tokens (coordinator + 22 subagents, Opus 5.5): 454k output, 24.3M
  cache read, 1.5M cache write. At list price ($4 in / $20 out,
  $0.20 cache read, $5 cache write per MTok) about $21.50.
- Parallel agents collided in git twice (one committed another's
  main.ts edit; one committed another's e2e edits and had to amend).
  AGENTS.md now says to stage only your own changes.
- Every agent read tasks/README.md only because the spawn prompt said
  so; AGENTS.md now points there.
- The no-dependency result came from the lazy ladder and from lifting
  old dependency-free code, not from an explicit rule; AGENTS.md now
  states it.
