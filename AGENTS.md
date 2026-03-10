# HAL

Small but capable Bun + TypeScript coding agent with multi-tab TUI, persistent sessions, and file-backed IPC.

Current code lives in `src/`; previous version is in `old-src/` for reference.

## Rules

- After every code change to `src/`, run `bun scripts/cloc.ts` and include the output.
- Use red-green TDD.
- To test, run ./test, never `bun test`
- Use Bun, never node.js. `bunx` - no `npx`. No build step.
- State is stored under `HAL_STATE_DIR` (default: `$HAL_DIR/state`).
- Secrets live in `$HAL_DIR/auth.ason` (gitignored). Non-secrets in `$HAL_DIR/config.ason`.
- Conversation events are append-only: `state/sessions/<id>/messages.asonl`.
- Tabs are real sessions; `/compact` rotates session history.
- Prefer tabs for indentation (width 4).
- When editing, collapse consecutive blank lines to one. Files should end with a newline.
- After completing a task, commit to git.
- Commit messages: use imperative sentence case (capitalized), e.g. `Add feature X`, `Don't do Y when Z`, `Rename zot to bar`. Keep subject concise (~50 chars), no trailing period. Skip `subsystem:` prefixes unless they add real clarity.
- If asked to learn something, write it to `AGENTS.md` so I can remember it the next time.
- If learning requires editing new code, edit the code and ask user to restart. 
- `[todo] <text>` — append the text as a bullet to `TODO.md` and commit. No questions, no hesitation.
- `/bug <description>` — captures terminal snapshot + debug log. You can paste images and text. Use it to self-debug UI issues.
- Keep code MINIMAL. No migration code unless asked! Screw backwards compatibility. But warn when stuff is going to break.
- Don't invent flags/presets/options that nobody will use.
- I'm on a laptop. It doesn't have Home and End keys for example.
- Prefer one working mechanism over layered fallbacks/proof-of-concept additions; only add another path when the first is clearly insufficient.
- Don't reimplement what the system already provides. For example, `open('wx')` is an atomic exclusive-create — no need to build a `mkdir`-based mutex on top of it.
- Doing a big task? 1. Read files and think. 2. Plan - write it to file (docs/plans). 3. Implement.
- Non-test runtime code budget: max 10k LOC. `bun run cloc` to check.

## User interface guidelines

Hal is plumbing-visible by default: don't try to hide complexity, file paths, or the like.

Bad: "[system] system prompt reloaded (file changed)"
Good: "[system] reloaded SYSTEM.md (file changed)" or "(model changed)"

Bad: "[promoted] this process is now the owner"
Good: "[promoted] pid 12345 is now the owner"

Insert `<blink />` (50ms pause) or `<blink ms="400" />` (custom duration) in streamed text for comedic timing, dramatic pauses, or musical phrasing. The tag is stripped from output and converted to a delay.

## TUI

- Canonical TUI behavior doc: `docs/tui.md` (update it with any TUI rendering/input behavior change).

- Avoid prompt/status flicker: keep terminal redraws in a single full-frame write.
- On kitty/ghostty-compatible TTYs, wrap frame writes with synchronized output (`\x1b[?2026h` ... `\x1b[?2026l`).
- If adding another frame write path beyond `render()`, factor the sync wrapper into shared helper/constants and use it everywhere frames are emitted.

## Testing

- **NEVER** use `bun --eval` or `bun -e` — Use `bunx tsgo --noEmit` for syntax/type checks.
- Write tests for new features and bug fixes
- Command for TDD loop: `bun test --test-name-pattern='<feature>'`
- Before committing, run tests: `./test` (parallel runner; `bun test` is sequential and slow)
- Unit tests live alongside code, e2e tests in `src/tests/`
- `src/cli/test-driver.ts` — lightweight harness for testing prompt/keybinding behavior. Uses `TestDriver` class: type chars, send keys, assert text/cursor/selection. See existing tests in `test-driver.test.ts`.

## SYSTEM.md preprocessor

`SYSTEM.md` is preprocessed before being sent to the model (`src/runtime/system-prompt.ts`):
- `${model}`, `${cwd}`, `${date}`, `${session_dir}` are replaced with runtime values.
- `::: if model="glob"` ... `:::` fenced blocks conditionally include content by model name.
- HTML comments are stripped.
- Consecutive blank lines are collapsed.
- `.asonl` files (conversation, session, IPC logs) use ASONL format — parse with `ason.parseAll()`, not line-by-line JSON.

## TODOs

See `TODO.md`.

## Eval tool

When `eval: true` is set in `config.ason`, an `eval` tool is available that executes TypeScript **inside the Hal process**. Use it to inspect/modify runtime state, call internal functions, or do anything that `bash` can't (since bash runs out-of-process).

- **`code`** parameter: TypeScript function body. `ctx` is in scope with `{ sessionId, halDir, stateDir, cwd }`. Use `return` to return a value.
- **Imports**: use `~src/` prefix to import from Hal source, e.g. `import { getConfig } from '~src/config.ts'`
- **Audit**: executed scripts persist in `state/sessions/<id>/eval/` — never deleted.
- **Permissions**: treated as a write tool — requires confirmation under `ask-writes` / `ask-all` permission levels.

## Architecture (high level)

- `run` — bash entry point. Restart loop (exit 100 = restart), env setup, `-f`/`-s` flag handling.
- `main.ts` — owner election + CLI startup.
- `src/ipc.ts` — file-backed IPC bus (`state/ipc/`). See `docs/ipc.md`.
- `src/runtime/*` — owner runtime (scheduling, commands, agent loop).
- `src/cli/*` — TUI + CLI client. See `docs/tui.md`.
- `src/session/*` — session persistence, messages, compaction, rotation. See `docs/session.md`.
- `src/session/compact.ts` — context compaction (strip old tool results, images, thinking). See `docs/context-compaction.md`.
- `src/providers/*` — provider adapters (Anthropic, OpenAI).
- `src/utils/ason.ts` — ASON serialization.
