# Making Hal actually work on mobile and web

Status quo and plan for the web client (`src/web-client/`). Written 2026-08-22
after fixing the tab bar; research input from field scans of Happy, Omnara,
Claude Code Remote Control, Codex iOS, GitHub Mobile, Moshi, Tactic Remote,
Termius/Blink/tmux workflows, and their user reviews (sources inline where they
shape a decision).

## Where we are

The web client is a compact supervision surface: tab strip, structured transcript,
multiline composer, and inline durable question blocks. It renders `SharedState` +
per-session snapshots over one WebSocket. Recent work includes:

- Tab strip no longer scrolls sideways (horizontal panning collides with
  browser back/forward swipe gestures). Tabs wrap into rows on desktop.
- Narrow screens collapse the strip into a ☰ button opening a full-screen
  session sheet: select, close (×), new tab (+). New/close reuse the existing
  `open`/`close` commands the terminal sends; `parseCommand` already accepts
  them over the WebSocket.
- Working dot (pulsing, per-session `working` state) and 🔔 attention badge
  (`session.attention === 'new'`).
- Layout moved off `position: fixed` magic paddings onto a flex column with
  sticky header/composer, `100dvh`, safe-area insets, 16px inputs (no iOS
  focus zoom), `touch-action: manipulation`.

What is still broken or missing, roughly in order of pain:

1. No notifications. An agent that finishes, stalls, or waits on a durable
   question is invisible until you open the page. Field research is unanimous:
   missed approvals are the #1 reason people abandon phone-based agent control.
2. Output is mostly raw `pre-wrap` text: no markdown, code blocks, collapsing of
   tool noise, copy button, or diff rendering. It remains hard to read on a phone.
3. Connection lifecycle is `location.reload()` after 1s on close. Backgrounded
   iOS Safari kills sockets constantly; reload loses scroll position and feels
   broken. There is no offline/connecting indicator.
4. The composer has multiline and queue controls, but still lacks abort,
   autocomplete, and a plan for increasingly complex mobile keyboard behavior.

## What the evidence says mobile is *for*

Ranked by observed frequency across reviews/threads (Happy, Omnara, Claude
Code remote-control discussions, r/ClaudeAI, HN):

1. Monitor long runs; unblock approvals; get notified when done.
2. Short steering prompts ("keep going", "not like that", voice-dictated).
3. Glance at summaries/diffs lightly; read the last assistant message.
4. Kick off a new task from a thought away from the desk.

Explicitly *not* done on phones: deep multi-file review, starting projects,
complex debugging ("serious review waits until I'm back at the Mac" — HN
48140529). Design consequence: optimize the phone UI for the
supervision loop (see → decide → nudge), not for typing or reviewing.
Tactic Remote's writeups call this "supervise, don't type"; their data point:
62% of approvals handled from the notification itself when notifications carry
enough context.

---

## Top 5 priorities

### 1. Question notifications

Inline durable questions now cover risky-tool approval end-to-end in terminal and
web clients: exact tool context, ordered No/Yes choices, history-backed restart,
and frozen ordinary composers. The remaining high-leverage work is notification:

- **Notify**: Web Push. Server gains VAPID keys + subscription storage
  (`web-push` semantics hand-rolled with `crypto.subtle` in Bun; payload is
  just "session X needs an answer", URL deep-links to the session). Push on
  active questions, turn completion, and errors. Client registers a service
  worker; clicking the notification focuses the tab and selects the session.
  This requires PWA installability on iOS; installed-PWA Web Push works since
  iOS 16.4.
- **Context in the notification**: include command/edit summary text so the
  decision can be made from the lock screen; tapping opens straight to the
  question block. This is the difference between used and ignored.

Acceptance: an agent blocked on a bash approval is resolvable from a locked
phone in ≤15 seconds without typing.

Safety: never offer permission bypass from the phone. Unanswered questions are
durable and have no automatic timeout; notify only when input is genuinely
needed and put notification opt-out in the first useful settings surface.

### 2. Session board as home screen

Tabs answer "which session am I in"; phones need "which session needs me".
Evolve the ☰ sheet into the default mobile landing view:

- Rows sorted: needs-attention first, then working, then idle; each row shows
  name, cwd tail, model, pulsing dot / bell, last activity time.
- Badges count pending approvals per session (server already tracks pending
  confirms in the agent loop; expose count via `SharedSessionInfo` if needed —
  prefer deriving client-side from live blocks to avoid protocol churn).
- Keep the sheet open after acting (select closes it; approve/close stays) so
  it works as a triage board.
- Desktop keeps the wrap-strip; the sheet becomes a dropdown panel.

Effort S-M. Impact H: this is what makes 3+ sessions usable from a phone.

### 3. Readable output

- **Markdown + code blocks**: render assistant/user text with a small
  markdown renderer (prefer a dependency-light one; must handle fenced code +
  inline code + lists + links; sanitize HTML). Code blocks get a Copy button
  and horizontal scroll *within the block* only (page never scrolls sideways).
- **Tool blocks collapsible**: `<details>`-style rows — `▸ bash · npm test ✓`
  collapsed by default, tap to expand input/output. Long outputs (>~2KB)
  truncate with "show more". The transcript builder (`utils/transcript.ts`)
  already pairs calls/results into single items — presentation-only change.
- **Streaming affordances**: blinking caret on the streaming assistant block;
  auto-follow already pauses when you scroll up (`webScroll.isNearBottom`) —
  add a floating "↓ newest" pill when paused, and keep it during streaming.
- **Diffs later** (side quest E); do not block markdown on diff perfection.

Effort M-L total, but shippable incrementally. Impact H: everything else reads
through this lens.

### 4. Connection lifecycle that survives phones

- Replace reload-on-close with explicit reconnect: same socket setup, backoff
  (0.5s→1s→2s→…cap 15s), resubscribe + re-bootstrap on open (server already
  sends full bootstrap on authenticate — reconnect is free).
- Status chip near the tab strip: ● live / ○ connecting / ✕ offline with last-
  updated time. Never a blank screen: keep last snapshot rendered while
  disconnected (stale-mark it).
- On `visibilitychange → visible`, force an immediate reconnect attempt if the
  socket is dead (iOS suspends timers in background; the backoff timer may be
  frozen — the visibility handler is the reliable wake-up).

- If the composer ever fights the iOS keyboard (fixed elements floating above
  it), fall back to visualViewport offset math; `interactive-widget=
  resizes-content` (now in index.html) handles Android. Re-check after adding
  any fixed overlay.
- Surface host liveness: `SharedHostInfo` has pid/startedAt; show "host down /
  Mac asleep" state when the socket cannot connect, plus the `hal` resume hint
  instead of silent retry forever.

Effort S-M. Impact H: this is the "does not feel broken on a phone" fix.

### 5. Composer fit for steering

- `<textarea>` auto-grow (1–6 rows), Enter=send, Shift+Enter=newline,
  `enterkeyhint="send"`. Keep 16px font.
- **Abort button** replaces Send while `working[selected]` (command `abort`
  with optional `abortText` already whitelisted). One-tap interrupt is the
  other half of the supervision loop.
- Optimistic send: append a dimmed user bubble immediately; reconcile when the
  event round-trips. Prevents double-taps feeling like nothing happened on
  laggy connections.
- Quick prompts: small chip row above the keyboard on mobile ("continue",
  "run tests", "commit") — configurable later via config; hardcode 3 defaults
  first. Evidence: snippet libraries are a top-3 Termius feature; Omnara users
  ask for reply-chips.
- Show queued-prompt count for the selected session if a queue exists
  (`prompt-queue` state) so steering attempts don't pile up invisibly.

Effort M. Impact M-H (this is how people actually use phones: short nudges).

---

## Side quests (next 5–10, unordered)

A. **PWA installability**: manifest (name, theme_color #111, display standalone,
   maskable icon), apple-touch-icon, standalone display. Prerequisite for iOS
   push; also removes Safari chrome. ~30 lines + two icon files.
B. **Diff viewer for edits**: when a tool call is edit-like, render stacked
   +/- lines with syntax tinting instead of JSON dump. Tap-to-expand full file
   comes later; landscape hint even later. (GitHub-Mobile lesson: reuse a good
   review shape rather than raw git text.)
C. **Usage/rate-limit glance**: host usage summaries exist server-side
   (`anthropic-usage`, `openai-usage`); render compact "5h ▮▮▮▯ resets 17:19"
   in the session sheet. People check this before launching another run.
D. **Voice input**: OS dictation is already fine on both platforms; add a mic
   button that just triggers `webkitSpeechRecognition` when present, else
   hides. Review-before-send is inherent since it lands in the textarea.
E. **Virtualize long transcripts**: opening old chats is the top performance
   complaint about Happy (minutes of catch-up). Cap initial render to last N
   items with "load earlier" at top; snapshots already arrive whole, so this
   is pure presentation windowing.
F. **Rename sessions from web**: `name` is editable via meta; a pencil in the
   sheet row. Tiny, makes the board scannable.
G. **Message permalinks**: hash routing exists (`#session-message`); wire the
   transcript to scroll/highlight the target on load (currently only session
   selection works). Enables "look at this" sharing desktop→phone.
H. **Image paste into composer**: screenshots-of-bug is a real mobile pattern;
   needs upload endpoint + attachment plumbing in prompt parts (parts already
   support non-text types in history).
I. **Preview links**: detect localhost dev-server ports mentioned in tool
   output; offer "open preview" that proxies through the web server (Bun
   fetch passthrough) so a phone can see the app the agent is building.
J. **Trust posture page**: token auth is already the credential; document +
   display expiry/revocation (`/web revoke` exists), warn when serving on
   non-localhost bind. Cheap trust win, aligns with E2EE expectations set by
   competitors.

## Open decisions

1. Phone reachability gates push: document LAN/Tailscale access first (the
   server binds 127.0.0.1; `/web` URLs already carry tokens), or add an
   optional relay. Pure-LAN cannot wake a phone on the internet; a relay makes
   push delivery trivial. Decide before building §1b.
2. Push mechanism: self-hosted ntfy-style webhook (user-configured endpoint,
   cheapest, matches OSS ethos) vs VAPID Web Push (needs installed PWA on iOS)
   vs both.

## Non-goals (deliberate)

- Native apps / APNs / FCM: Web Push + installed PWA covers it; revisit only
  if interactive notification buttons prove decisive.
- IDE-in-the-browser (code-server path): consistently reviewed as unusable on
  phones; we are a supervision surface with a terminal escape hatch, not an IDE.
- Mirroring the TUI: rebuild as chat/cards; the terminal stays canonical on
  desktop. Honest framing: web is a *window into the real session*, and the
  server owns all state — which we already have.

## Sequencing

1. §1a approvals rendered + banner (unblocks the core loop; no infra).
2. §4 connection lifecycle + §5 composer basics (textarea/abort/optimistic).
3. §3 markdown/collapse/streaming pills.
4. Side quest A (manifest/SW) then §1b-c Web Push.
5. §2 session board polish; then side quests by itch.

Each step keeps `./test` green; UI-only steps need no new tests beyond
existing transcript/utils coverage (Solid components remain untested per
docs/web.md until someone pays the browser-condition tax).
