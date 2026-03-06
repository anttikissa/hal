# HAL

Minimal Bun + TypeScript agent with multi-tab TUI and file-backed IPC.

## Rules

- After every code change to `new/`, run `bun scripts/cloc.ts` and include the output.

- Never restart the app unless the user explicitly asks. Restart kills all tabs — other tabs may have active generations that would be lost.
- Use Bun, never node.js. `bunx` - no `npx`. No build step.
- State is stored under `HAL_STATE_DIR` (default: `$HAL_DIR/state`).
- Secrets live in `auth.ason` (gitignored). Non-secrets in `config.ason`.
- Conversation events are append-only: `state/sessions/<id>/messages.asonl`.
- Tabs are real sessions; `/handoff` rotates session history and writes `handoff.md`.
- Prefer tabs for indentation (width 4).
- When editing, collapse consecutive blank lines to one. Files should end with a newline.
- After completing a task, commit to git.
- Commit messages should start with a capital letter (conventional prefixes like `fix: ` may be lowercase).
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

## SYSTEM.md preprocessor

`SYSTEM.md` is preprocessed before being sent to the model (`src/system-prompt.ts`):
- `${model}`, `${cwd}`, `${date}`, `${session_dir}` are replaced with runtime values.
- `::: if model="glob"` ... `:::` fenced blocks conditionally include content by model name.
- HTML comments are stripped.
- Consecutive blank lines are collapsed.
- `.asonl` files (conversation, session, IPC logs) use ASONL format — parse with `ason.parseAll()`, not line-by-line JSON.

## TODOs

See `TODO.md`.

## Architecture (high level)

- `run` — bash entry point. Restart loop (exit 100 = restart), env setup, `-f`/`-s` flag handling.
- `main.ts` — owner election + CLI/web startup.
- `src/ipc.ts` — file-backed IPC bus (`state/ipc/`). See `docs/ipc.md`.
- `src/runtime/*` — owner runtime (scheduling, commands, agent loop).
- `src/cli/*` — TUI + CLI client.
- `src/web.ts` — web UI + SSE.
- `src/session.ts` — session persistence + handoff rotation. See `docs/session.md`.
- `src/provider.ts` + `src/providers/*` — provider adapters.
- `src/utils/ason.ts` — ASON serialization.
