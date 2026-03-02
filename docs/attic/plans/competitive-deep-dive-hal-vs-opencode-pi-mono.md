# HAL Competitive Deep Dive (vs OpenCode and pi-mono)

Date: 2026-02-22
Scope: Current HAL rewrite in this repo, compared against local clones in `examples/opencode` and `examples/pi-mono`.

## 1) HAL goals (explicit)

HAL should optimize for:

- Small codebase
- Fast startup and interaction
- Zero runtime dependencies (Bun + stdlib + first-party code only)
- Strong terminal UX (multi-tab TUI, low-latency, keyboard-first)

Secondary goals:

- Safe enough by default, but still fast for expert use
- Easy to reason about architecture (file-backed state + simple modules)
- Good observability and debuggability

## 2) What competitors do well

## OpenCode (examples/opencode)

Strengths:

- Very polished TUI and product surface
- Multi-agent modes (build/plan/general)
- Strong provider-agnostic story
- LSP integration and editor-style workflows
- Client/server architecture that enables multiple frontends
- Mature docs, packaging, installation channels

Takeaways for HAL:

- Distinct “modes” reduce accidental edits and improve trust
- TUI polish materially improves perceived model quality
- Splitting core runtime from UI unlocks future clients without rewrites

## pi-mono (examples/pi-mono)

Strengths:

- Clean package boundaries (ai, agent, coding-agent, tui, web-ui)
- Unified model abstraction across providers
- Reusable terminal UI infrastructure (differential rendering approach)
- Extensibility via agent runtime + tools + skills
- Broader ecosystem (Slack bot, deployment tooling)

Takeaways for HAL:

- Tight abstraction boundaries make adding features less risky
- Differential terminal rendering helps responsiveness
- Extensibility should stay simple but intentional (hooks, profiles, skills-lite)

## 3) HAL current state (high-level)

What HAL already has:

- Owner/client architecture with file-backed IPC
- Real tab sessions with persistent state and handoff
- Commands for model/system/pause/handoff/cd/reset/fork/restart/bug/snapshot
- Test mode + e2e harness
- Web server path
- Debug logs and bug snapshots

What HAL intentionally avoids:

- Heavy framework dependencies
- Large plugin framework complexity

## 4) Feature gap matrix (priority view)

Legend: Have / Partial / Missing

1. Core coding loop and tools
- Bash + file edit + search primitives: Have
- Tool reliability controls (timeouts, retries, budgets): Partial
- Structured execution plans/checkpoints: Partial

2. Safety and operating modes
- Read-only planning mode: Missing
- Approval policy profiles (always ask / auto for safe ops): Missing
- Per-command risk banners (destructive/network/shell): Missing

3. TUI capabilities
- Multi-tab sessions: Have
- Input history and multiline handling: Have
- Fast incremental rendering (line-level diff strategy): Partial
- Rich panes (files/tools/timeline/inspect): Missing
- Keyboard discoverability (command palette/help overlays): Partial
- Session timeline navigation/rewind: Missing

4. Session/memory
- Persistent sessions and handoff: Have
- Session branching/compare/merge UX: Partial (fork exists, compare/merge missing)
- Project memory (facts/preferences) with explicit controls: Partial (AGENTS + logs only)

5. Code intelligence
- LSP diagnostics/symbol/navigation: Missing
- Project map/index for fast local reasoning: Partial (basic stats only)
- Smart file watcher/context refresh: Missing

6. Provider/model ops
- Multi-provider adapters: Have
- Per-tab model profiles and budgets: Partial
- Fallback/hedging between models: Missing

7. Extensibility
- Internal module boundaries: Partial-good
- User-level extensions/skills API: Missing
- Safe custom commands/macros: Partial

8. Observability
- Debug logs and snapshots: Have
- Tool telemetry dashboards (latency/error rates): Missing
- Repro capture/replay for failing sessions: Partial

## 5) What HAL should implement next (small+fast aligned)

## Immediate (1-2 days)

1. Agent modes: `build` and `plan`
- `plan` mode enforces read-only file ops and asks before bash.
- Minimal implementation: mode flag in session + checks in command/tool dispatch.
- Big trust gain, low code size.

2. Approval profiles
- `default`, `safe`, `yolo` profiles.
- Profile controls bash/file edit/network permissions and prompts.
- Keep as plain config in `config.ason` + per-session override.

3. TUI quick wins
- Add command palette (`Ctrl-P`) listing commands/actions.
- Add sticky key hint bar (single line, concise).
- Add lightweight tool activity panel toggle.

4. Per-tab model settings
- Persist model + temperature/context policy per session.
- Existing `/model` becomes tab-scoped with explicit output.

## Near-term (1-2 weeks)

5. Session timeline and replay-lite
- Show recent commands/events in a side panel.
- Jump to key checkpoints (fork/reset/handoff/tool-run boundaries).

6. Structured task checkpoints
- Introduce optional step list for long tasks:
  - plan
  - execute
  - verify
  - summarize
- Store in session metadata (small ASON objects).

7. Project map cache
- Lightweight symbol/file map (no heavy indexer).
- Refresh on demand and on changed files.
- Improves speed and answer quality in larger repos.

8. Tool budgets and guardrails
- Per-turn max tool calls
- Per-command timeout caps
- Clear UI when budget/time exceeded

## Strategic (2-6 weeks)

9. LSP-lite bridge (optional)
- Start with diagnostics + go-to-definition for TS/JS via external language server process.
- Keep it optional and lazy-loaded to protect startup speed.

10. Minimal extension hooks
- Register custom slash commands from local script files.
- Strict sandbox + explicit allowlist.

11. Multi-client robustness
- Harden concurrent client behavior and ownership transitions.
- Add event ordering guarantees and clearer session targeting in e2e tests.

## 6) TUI roadmap specifically (where competitors are ahead)

Top missing UX pieces relative to OpenCode/pi quality:

- Inspectable tool timeline (what ran, when, exit code, duration)
- Better spatial layout (optional right-side inspector)
- Mode visibility (build vs plan obvious at all times)
- Faster visual diffing in output regions to reduce redraw churn
- Better keyboard ergonomics for tab/session operations

Recommended sequence:

1) Timeline strip + inspector toggle
2) Mode badge + profile badge in status line
3) Palette/help overlay
4) Incremental redraw pass optimization

## 7) Keep-or-reject list (to stay small)

Do:

- Small features with high trust/UX payoff
- Optional advanced features behind flags
- Data formats simple and append-friendly (ASON)

Do not do (yet):

- Heavy plugin marketplace architecture
- Full IDE replacement ambitions
- Big dependency trees for UI niceties

## 8) Suggested success metrics

- Cold startup time (ms)
- First input-to-render latency (ms)
- Tool execution success rate (%)
- Number of accidental destructive actions (should trend to zero)
- Median time-to-complete for common tasks
- Test suite runtime (quick and full)

## 9) Recommended next PR stack

PR 1: Modes + approvals
- Add session mode (`build|plan`)
- Add approval profile plumbing
- Enforce in tool/command path

PR 2: TUI discoverability
- Command palette
- Status badges for mode/profile
- Key hints

PR 3: Timeline inspector
- Event list model
- Toggle panel in TUI
- Minimal drilldown (command/tool metadata)

PR 4: Project map cache
- Build/update map
- Query helpers used by runtime prompts

This order gives the highest practical gain while preserving HAL’s small/fast/no-deps identity.
