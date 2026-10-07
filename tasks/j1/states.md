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

## Supervised server mode (fd1)

With `hostMode: 'server'`, local peers never become host. They wait for
`hal serve`, including across crashes and intentional restarts. The
headless host runs in the foreground under a supervisor. SIGHUP is
ignored; SIGTERM/SIGINT stop it without pausing unfinished turns, so an
explicit service stop stays stopped and a later start recovers them.
SIGUSR1 and `/restart` exit with the intentional restart code. Terminal
quit only closes the client. The automatic-mode rules below remain the
default; in server mode recovery belongs to the supervised host, not a
peer.

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

Messages waiting in the inbox are not a state: they are
visible data attached to a session in any state. Neither is a slash
command's question (/login, /cd): the state belongs to the turn, and
nothing outside the turn may overwrite what the host knows about it,
say by re-deriving the state from history.

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

Ordinary submitted text immediately interrupts the active provider round,
locally and remotely alike. The host durably receives it in the inbox
before aborting the round signal, preserves partial output, settles any
running foreground tool, and never dispatches pending calls after receipt.
A running call flagged unsafeToStop is not stopped: the message waits in
the inbox until the call ends (task ker).
Only then does the same logical turn request again, delivering all waiting
messages together in receipt order. Repeated submits during settlement
coalesce without loss or duplication. Escape or closing the tab clears
restart intent and leaves the inbox waiting until continue or a new submit.
Interrupted rounds are not user pauses. Host recovery and command-ID
deduplication use durable history; no private client interruption path.
Alt-Enter chooses after-this-turn delivery and never interrupts.
Next-round messages wait without aborting; send steer:true chooses interrupt
delivery and uses ordinary submission semantics. Neither next-round nor
after-this-turn delivery undoes an explicit pause. Ordinary submission also
cancels retry/login waits; the next request re-evaluates the failure or login rather than stranding text.
Slash commands retain their own immediate command behavior.
Model, cwd, instruction and turn-status notices reach the next request,
including within a turn. They do not start or resume work by themselves.
Effective model and cwd changes interrupt active work and continue with the
new context, independent of the submit key (task 6eq). They reuse hard
steering, including safe tool settlement, and leave idle or paused work alone.
Live blocks keep their start position; commands arriving during thinking appear
below that block in both clients, live and restored.
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
implementation is the reference for behavior, not for code.

## Drafts and sending (task for drafts)

Text the user typed is precious. It is never lost to a disconnect,
reconnect, restart or crash. A draft follows the session across clients:
start a prompt in the terminal, close the laptop, continue on the phone.
A sent prompt shows at once (optimistic), marked pending until the host
has it. While disconnected it stays pending and is sent on reconnect.
Every command carries an id made by the client, so a resend never
submits twice.
