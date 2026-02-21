# HAL (New)

Minimal Bun + TypeScript agent with multi-tab TUI and file-backed IPC.

## Rules

- Use Bun. No build step.
- State is stored under `HAL_STATE_DIR` (default: `$HAL_DIR/state`).
- Secrets live in `auth.ason` (gitignored). Non-secrets in `config.ason`.
- Prompt logs are append-only: `state/sessions/<id>/prompts.ason`.
- Tabs are real sessions; `/handoff` rotates session history and writes `handoff.md`.
- Prefer tabs for indentation (width 4).
- Commit messages should start with a capital letter (conventional prefixes like `fix: ` may be lowercase).
- If asked to learn something, write it to `AGENTS.md` so I can remember it the next time.
- `[todo] <text>` — append the text as a bullet to `TODO.md` and commit. No questions, no hesitation.
- `/bug <description>` — captures terminal snapshot + debug log. You can paste images and text. Use it to self-debug UI issues.


## TODOs

See `TODO.md`.

## Architecture (high level)

- `main.ts` — owner election + CLI/web startup.
- `src/ipc.ts` — file-backed IPC bus (`state/ipc/`).
- `src/runtime/*` — owner runtime (scheduling, commands, agent loop).
- `src/cli/*` — TUI + CLI client.
- `src/web.ts` — web UI + SSE.
- `src/session.ts` — session persistence + handoff rotation.
- `src/provider.ts` + `src/providers/*` — provider adapters.
- `src/utils/ason.ts` — ASON serialization.
