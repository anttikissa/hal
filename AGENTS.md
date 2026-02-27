# HAL (New)

Minimal Bun + TypeScript agent with multi-tab TUI and file-backed IPC.

## Rules

- Use Bun, never node.js. No build step.
- State is stored under `HAL_STATE_DIR` (default: `$HAL_DIR/state`).
- Secrets live in `auth.ason` (gitignored). Non-secrets in `config.ason`.
- Conversation events are append-only: `state/sessions/<id>/conversation.ason`.
- Tabs are real sessions; `/handoff` rotates session history and writes `handoff.md`.
- Prefer tabs for indentation (width 4).
- When editing, collapse consecutive blank lines to one. Files should end with a newline.
- After completing a task, commit to git.
- Commit messages should start with a capital letter (conventional prefixes like `fix: ` may be lowercase).
- If asked to learn something, write it to `AGENTS.md` so I can remember it the next time.
- If learning requires editing new code, edit the code and ask user to restart. 
- `[todo] <text>` — append the text as a bullet to `TODO.md` and commit. No questions, no hesitation.
- `/bug <description>` — captures terminal snapshot + debug log. You can paste images and text. Use it to self-debug UI issues.
- Keep code MINIMAL. Don't take measures to maintain backwards compatibility unless explicitly required.
- For one-off/throwaway helper scripts (debugging, calibration, capture) and rare new-test scaffolding/generators, prefer the shortest thing that works. Start with a zero-argument happy path and sensible defaults (infer from env/project context when possible). Don't front-load flags/presets/options unless explicitly requested, and don't add lots of optional flags the user won't use.
- For interactive key-capture/test prompts, assume a laptop keyboard by default (no dedicated Home/End/PageUp/PageDown keys) unless the user says otherwise. Start with a minimal key set and add more only as needed.
- Don't ask the user to do trivial local setup steps the script can do itself (for example clearing clipboard before a capture step). Automate it if needed, otherwise omit the instruction.
- Prefer one working mechanism over layered fallbacks/proof-of-concept additions; only add another path when the first is clearly insufficient.
- Don't reimplement what the system already provides. For example, `open('wx')` is an atomic exclusive-create — no need to build a `mkdir`-based mutex on top of it.
- Doing a big task? 1. Read files and thing. 2. Plan - write it to file (docs/plans). 3. Implement.

## User interface guidelines

Hal is plumbing-visible by default: don't try to hide complexity, file paths, or the like.

Bad: "[system] system prompt reloaded (file changed)"
Good: "[system] reloaded SYSTEM.md (file changed)" or "(model changed)"

Bad: "[promoted] this process is now the owner"
Good: "[promoted] pid 12345 is now the owner"

## Testing

- Write tests for new features and bug fixes
- Command for TDD loop: `bun test --test-name-pattern='<feature>'`
- Before committing, run tests: `bun test`
- Unit tests live alongside code, e2e tests in `src/tests/`

## SYSTEM.md preprocessor

`SYSTEM.md` is preprocessed before being sent to the model (`src/system-prompt.ts`):
- `${model}`, `${cwd}`, `${date}`, `${session_dir}` are replaced with runtime values.
- `::: if model="glob"` ... `:::` fenced blocks conditionally include content by model name.
- HTML comments are stripped.
- Consecutive blank lines are collapsed.
- `conversation.ason` files use ASON format — parse with `ason.parseAll()`, not line-by-line JSON.

## TODOs

See `TODO.md`.

## Architecture (high level)

- `main.ts` — owner election + CLI/web startup.
- `src/ipc.ts` — file-backed IPC bus (`state/ipc/`). See `docs/ipc.md`.
- `src/runtime/*` — owner runtime (scheduling, commands, agent loop).
- `src/cli/*` — TUI + CLI client.
- `src/web.ts` — web UI + SSE.
- `src/session.ts` — session persistence + handoff rotation. See `docs/session.md`.
- `src/provider.ts` + `src/providers/*` — provider adapters.
- `src/utils/ason.ts` — ASON serialization.
