# Session states

Decided with the user on 2026-09-26. The old Hal kept pausing sessions
when it shouldn't, grew a bloated question feature, and recovered from
laptop sleep only sometimes, because nobody had written down how a
session *should* behave. This is that description. Tasks j1 and later
implement parts of it; they may refine names, not rules.

## Terms

- **host**: the one process that owns a home: sessions, provider calls,
  every write to state. It also serves remote terminal and web clients.
- **peer**: another Hal process on the same machine in the client role.
  It can become host when the host goes away.
- **client**: anything following sessions: the host's own terminal, a
  peer, a browser, later a host on another machine.
- **server**: only the listeners (Unix socket, HTTP). Not a role.

## States

One state per session at any time, derived by the host from history
plus its own memory, sent in every snapshot and change event.

| state | meaning | who ends it |
|---|---|---|
| idle | nothing to do; last turn completed | the user, by sending |
| running: requesting / streaming / tools | a turn is in progress | the turn itself |
| retrying (at T, reason) | a failure the host is fixing on its own | the host at T, or the user (Escape) |
| blocked (reason) | needs a human: login now; approval later | the human answering |
| paused | the user stopped it; the turn can continue | the user (continue, or send) |
| error | the turn ended on a request the host can't fix (bad request: usually a Hal bug) | the user, after fixing Hal: continue retries |

Invariant, and the test for it: every state other than idle, paused and
error names what ends it: a live stream or tool, a time T, or a
human-facing reason. A session that waits on nothing is a bug.

Queued and steering messages (the inbox) are not a state: they are
visible data attached to a session in any state.

## Who may stop work

1. **Escape** pauses the current session only. It is the same as
   quitting and restarting, without the restart. A paused turn resumes
   on continue (bare Enter) or when the user sends something.
2. **Ctrl-C** quits this process. If another Hal process remains, it
   becomes host and carries on every running turn: nothing pauses. Only
   when no process remains are running turns recorded as paused (a
   browser page is not a Hal process: it can't carry turns on).
   SIGTERM and SIGHUP are the same deliberate quit as Ctrl-C. Reason:
   a runaway (say, sessions spawning sessions in a loop) must stop and
   stay stopped until the user has looked at it.
3. **Ctrl-R** reloads code and continues exactly where it was: every
   running turn continues on the restarted host.
4. **Host death** (crash, kill -9) with a peer alive is the same as 3:
   the new host continues.
5. Nothing else pauses. Not a disconnect, not a failed request, not
   sleep. Failures are retrying, blocked or error, never paused.

Mechanism that makes 2–4 simple: a turn with no end record is
unfinished; a new host continues every unfinished turn. Paused is an
explicit durable record written only by an explicit user action (Escape,
or Ctrl-C of the last process). So SIGKILL needs no special handling:
nothing is written, and the new host continues.

Continuing tells the model what happened (the old Hal: "The previous
response was interrupted. Continue without repeating completed work.").
A tool call recorded without a result "may or may not have run" and is
never re-run automatically.

Guard: a turn that brings down every host that continues it must not
loop forever. After a few continuations of the same turn without
progress, pause it with a reason.

## Failures (task for retries)

- Temporary (connection dropped, wifi, tethering gone, 5xx, 529,
  stalled stream): retry at once, then back off; visible as retrying.
  Keeps going until it works or the user presses Escape.
- 429 / quota: rotate to the next account for the same model, as the
  old Hal does (account-rotation.ts). If every account is limited,
  retrying at the time the provider gives (retry-after, or the reset
  time in the body), which can be hours away. Must survive restart.
- Auth broken (401, refresh token rejected, e.g. a copied credentials
  file): blocked on login; continue by itself once credentials work.
- Every round uses the session's model as it is when the round starts,
  so /model counts from the next request even inside a turn. A switch
  while retrying or blocked ends the wait at once and tries the new
  model: a login broken for one provider must not hold a session that
  moved to another.
- Laptop sleep: after wake it must just work, as if the lid had never
  closed. This is hard to test, so defensive code is allowed here (and
  only here): detect the wake (timer gap, clock jump) and treat every
  stream open across it as dropped.
- Bad request (400) and other unexpected errors: usually a Hal bug or
  an unexpected model limit (say, no image support). The turn ends in
  error, showing the provider's message. The user fixes Hal, restarts or
  hot-patches, then continues; continue retries the request.

## Talking while it works (task for the inbox)

The user talks to models like a chat: several messages while the model
is still working. Sending while a turn runs steers it: the messages go
into the session inbox and the model gets them together at the next
round boundary. Alt-Enter queues instead: it runs after the turn ends.
A turn that streams nothing (retrying, blocked on a login) has nothing
to steer: a message then joins the transcript at once, in the order
typed, and the round after the wait takes it in. The user is just
typing into the transcript; no (steering, waiting) labels.
A restart (Ctrl-R) never changes what the user sees.
The inbox is always visible; nothing hides behind a command. The old
queue told the user "1 message in the queue, use /queue" and sometimes
never ran it: every queued message must either run or stay visibly
waiting with the reason.

## Editing the last prompt (task for amend)

Up arrow on an empty prompt while the model works pauses the turn and
puts the last prompt into the editor. What sending the edit does depends
on what happened since that prompt:

- nothing, or only read-only tools: the edited prompt replaces the old
  one, and the turn runs again as if it had been written that way;
- tools with side effects (bash, write, edit, ...): history stays; the
  edited prompt is sent on top of it.

Down with the text unchanged (or Escape) continues the paused turn. The
user relies on this every day and says it has never failed; the old
implementation is the reference for behaviour, not for code.

## Drafts and sending (task for drafts)

Text the user typed is precious. It is never lost to a disconnect,
reconnect, restart or crash. A draft follows the session across clients:
start a prompt in the terminal, close the laptop, continue on the phone.
A sent prompt shows at once (optimistic), marked pending until the host
has it. While disconnected it stays pending and is sent on reconnect.
Every command carries an id made by the client, so a resend never
submits twice.
