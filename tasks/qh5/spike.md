# Claude Agent SDK spike (2026-11-15, session 05-reg)

Question: can Hal run Anthropic subscription turns through the Claude
Agent SDK (claude-agent-sdk 0.3.325 / claude-cli 2.1.325) instead of
calling the Messages API directly with an OAuth token and a claude-cli
User-Agent (src/host/anthropic.ts), without real UX harm, and with
account rotation?

Artifacts (uncommitted):
- A spike plugin (not committed, 244 lines): provider
  `claudesdk/<model>`. One long-lived `claude` process per Hal session
  via streaming input. Hal system prompt as custom `systemPrompt`;
  built-in tools off (`tools: []`); Hal's native `tool` exposed via
  `createSdkMcpServer`; tool results come from Hal's next round. On
  restart, history is seeded through a synthetic SessionStore. Strips
  Hal's cache_control (5m markers clash with CC's 1h -> 400).
- /tmp/hal-05-reg-sdk/: bench.ts (modes latency, warm, toolround, seed,
  loop, rotate, parallel; PROXY=1 routes via proxy.ts), proxy.ts
  (logging proxy, dumps body-N.json), replay.ts (replays captured Hal
  vs SDK requests with variants), hal-r3.json, sdk-r3.json.

## Latency (claude-opus-5-5, ~10.9K-token prompt)

| Case | TTFT | Notes |
|---|---|---|
| Direct API (Hal today) | 1.00-1.33 s | |
| SDK, new process per turn | 1.34-1.95 s | total 2.4-2.9 s; ~440 ms spawn |
| SDK, long-lived process, warm | 0.97-1.07 s | first turn 1.7 s |
| SDK, very first run on a Mac | 4.8 s | 3.7 s startup (Gatekeeper/cold disk) |

Tool loop (6 calls, 3 reps), per round: direct ~1.55-1.85 s, SDK
~2.15-2.45 s => **+~0.5 s per tool round**. Claude Code's own local
overhead between rounds is only ~20 ms (debug log), so the extra is
server-side.

Attribution by replaying captured requests (7 reps, median ms to
headers): hal 1475; sdk 1976; sdk without system-role message 1434;
sdk with a tiny system-role message 1489; env text moved into user
message 1977. Effort, context_management, betas, UA, billing header,
metadata variants: all still ~1.9-2.1 s. hal with 1h TTL: 1587.

=> The +0.5 s is caused by the `# Environment` block (cwd, platform,
shell, OS, untrusted-downloads paragraph, model, date) that Claude Code
injects at messages[1] even with a custom systemPrompt. Server-side
reason unknown (maybe classifier/safety path keyed on that content).
No env flag found to disable it (CLAUDE_CODE_SIMPLE=1 crashed).
Possible fixes: find its gating in cli.js, or point the SDK at a local
ANTHROPIC_BASE_URL proxy that strips it (but then requests are no
longer "exactly what Claude Code sends").

Other per-turn effects:
- Round ~6 of a long tool loop: CC adds a critical_system_reminder
  ("The user hasn't heard from you in a while...") costing +1.1 s once;
  removed with CLAUDE_CODE_DISABLE_ATTACHMENTS=1.
- Extra session-title request per session on opus; removed with
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 (also stops telemetry
  POST event_logging).

## Request differences SDK vs Hal direct

SDK: UA `claude-cli/2.1.325 (external, sdk-ts, agent-sdk/0.3.325)`,
billing system block `x-anthropic-billing-header cc_entrypoint=sdk-ts`,
1h cache TTL markers, ~12 betas (4 with
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1), max_tokens 128000, thinking
adaptive (display updates), effort medium, context_management
clear_thinking. Hal direct: UA `claude-cli/2.1.322 (external, hal)`,
thinking adaptive summarized, tools `tool` + web_search.

## Correctness findings

- systemPrompt snapshot defaults on: CC records the system prompt once
  per session and ignores later changes. Hal changes it mid-session
  (e.g. spawn budget), so the plugin restarts the process on change;
  core must set snapshot off or restart.
- Subagents work: a claudesdk subagent made parallel calls, spawned a
  nested claudesdk subagent, WAITed, got the result. Fixed bugs on the
  way: cache_control clash (400), record state before yielding done,
  match tool results per native call. Untested: restart when Hal adds
  hal-note messages. Seen but unattributed: WAIT returning "needs
  attention" early, stray "No response requested.".

## Account rotation

Works. Two subscription accounts: turn 1 on account A; a fresh process on
account B resumed via SessionStore recalled the turn-1 secret. Cache is
per account (B: cacheRead 0, cacheWrite 10918) - same miss as the
direct path today. TTFT ~2.8 s per switch incl. ~0.4-0.55 s init.
SDK emits SDKRateLimitEvent (status, resetsAt, rateLimitType
five_hour/seven_day, utilization) usable for Hal's usage ranking.
CLAUDE_CODE_MAX_RETRIES and CLAUDE_CODE_RETRY_WATCHDOG* can stop CC's
internal retries hiding 429s. Spike picks the token only at process
start; a switch requires a process restart (one ~0.5 s hit per switch).
Task qh5 plans per-account CLAUDE_CONFIG_DIR.

## Resource cost

- Hal startup +0; SDK lazy import 46-64 ms on first claudesdk turn.
- Plugin reload closes processes; next turn ~0.45 s spawn.
- ~240-270 MB RSS per claude process per active session.
- Disk 439 MB (claude binary 337 MB), downloaded on first use.

## Cache TTL (side analysis, past week)

41 sessions, 7,971 Anthropic rounds; gaps <=5m 7740, 5-60m 138,
>60m/first 93. Cost: 5m everywhere $481.33; 1h everywhere $513.11
(+6.6%); 1h system+tools / 5m messages $480.64 (-0.14%). Keep 5m.
SDK forces 1h markers, so it costs ~+6.6% on cache writes.

## Plugin vs core

Plugin is feasible (provider.register; plugin.set refuses providers)
but depends on internals (anthropic.toMessages/parse). Since qh5
replaces the direct OAuth path, core is the better home.

## Legal context (as understood, not legal advice)

- Personal use of one's own subscription through the Agent SDK: fine.
- Agent SDK docs: shipping claude.ai login in a third-party product
  needs Anthropic's approval.
- Hal's current path (direct OAuth + claude-cli UA) is the pattern
  Anthropic has acted against for third-party harnesses.
- Argument to weigh: sending byte-identical requests to what the Agent
  SDK sends may be defensible as consumer use; the SDK itself is the
  fallback if Anthropic objects.

## Independent review (openai/gpt-6-astra, 2026-11-15)

Benchmarks: the tool-loop comparison is not like for like (direct
timed to a parsed tool call, SDK to content_block_start; SDK had
thinking off, direct adaptive). Replay is stronger evidence but ran
variants in fixed order, without dispersion or cache usage. Next:
randomized paired replay, original env block vs equal-length neutral
text, warmed, one account, recording cache usage and completed tool
arguments. The +6.6% is API-price math, not measured subscription use.

UX: a repeatable per-round penalty is a real harm; first-run download
and per-switch startup are acceptable. This task said a process per
turn; the good timings need one long-lived process per session.
Rotation is shown feasible, not production-ready: the test used two
accounts in one shared config dir, the spike picks the account only at
start and ignores SDKRateLimitEvent. Missing acceptance cases: separate
login dirs with token refresh, rate-limit-triggered switching,
simultaneous sessions, resuming pending tool results without losing or
repeating actions, steering and hal-note changes.

Legal (not legal advice): byte identity is not authorization. Consumer
terms bar automated access without an API key or explicit permission;
the Usage Policy effective 2026-11-12 addresses unauthorized proxying
through consumer subscriptions and client misrepresentation. Personal
use of the unmodified SDK is supported by Claude Code's legal docs;
distributing claude.ai login needs Anthropic's approval. No rule
against several accounts, but pooling quota is not authorized and
switching accounts to evade a ban is forbidden.

Recommendation: build the real long-lived SDK adapter in core for
personal use, with per-account login dirs and rate-limit rotation;
keep API keys for distribution; confirm the +0.5 s with the paired
replay before considering a stripping proxy; retire direct OAuth once
the SDK path passes acceptance.
