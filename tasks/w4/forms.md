# Forms, commands and modals

Decided with the user on 2026-09-27. The old Hal's question feature
grew too big (encrypted secrets, special cases per client, remote /cd
hacks). This is the smaller design. Tasks w4, et, 6f, kv and 0x
implement it; later tasks extend it. Refine names, not rules.

## Forms

One building block for asking a human anything: a form, a list of
fields.

| field | examples |
|---|---|
| text, with placeholder, may be empty | "How should I call you? ___ (Dave: leave empty to stay nameless)" |
| secret | /login: API key, pasted code |
| choice: y/N, Y/n, a list, or a single "press Enter" | approval, "/cd: create it?", the intro's "continue" |
| checkboxes | find: show tool calls / thinking / discussion / crosstalk |
| level (left/right) | thinking level |
| tree with search | model picker (later) |

The same fields render in two places.

## In a block (durable)

Questions that are part of the session: tool approval, questions from
synthetic models (the intro), command confirmations. Written to history,
shown as a block, answerable from any client (first answer wins),
survive restart. While one is open the session is `blocked (question)`
(tasks/j1/states.md).

Nothing waits in memory for an answer: whoever asked is re-run with the
answer (a command gets `run(args, answers)`; a tool batch continues).

Real models get no ask tool: conversation is enough. Synthetic models
and commands may ask.

Secrets are not encrypted: HTTPS covers the web, and locally the same
data is in files anyway. History records only that a secret was given.

## Commands

`src/host/commands/<name>.ts`, one file per slash command, found by
listing the directory. Each exports:

```ts
{ description, category, help?(args), complete?(args), run(args, answers?) }
```

- They run on the host. Completion is a protocol request, so
  `/cd ~/projec<Tab>` completes against the host's files for terminal,
  web and remote clients alike. No command may need per-client code
  for this.
- `/help` lists commands grouped by `category`; `/help <name>` shows
  `help(args)`.
- A command asks by returning a durable question; the answer re-runs it.
  Example: `/cd ~/sync/project` returns "directory not found. Create
  one? (Y/n)"; Enter re-runs with `{ create: true }`.

### Keys and client-only commands (task x0)

Every command, whether the host or the client runs it, is one file and
one entry in one list, so `/keys`, `/help`, completion and the key
dispatcher can never disagree.

- **The list** lives in `src/common/commands/`: per command its name,
  `description`, `category`, optional `key` and optional `clientOnly`.
  Host and clients import it. The host's command files keep their
  `run`/`complete`/`help` in `src/host/commands/<name>.ts`; client-only
  commands keep their action in `src/client/commands/<name>.ts`. A
  name is in exactly one of the two.
- **`key`**: a key label as `common/key-help.ts` writes them
  (`'ctrl-m'`, `'shift-ctrl-t'`, `'f1'`). Pressing it runs the command
  with no arguments, exactly as if `/<name>` were typed and sent. A
  command that needs an argument opens its picker (a modal or a
  question) when run bare, so it can still have a key. One key, one
  command; a test fails on duplicates.
- **`clientOnly: true`** (default false, and never written out when
  false): the client runs it itself and never sends it to the host:
  /quit, /restart, /suspend, /redraw, and the tab commands whose effect
  is the client's own view. Typing `/restart` does exactly what Ctrl-R
  does. The host still lists these names for completion and `/help`.
  If one reaches the host anyway (another session sends `/restart`,
  see Provenance), the host answers "only a client can run /restart"
  and does nothing: a session may not quit or restart the user's
  terminal.
- **Emergency keys** (tasks/README.md) keep their route. `/quit`,
  `/suspend` and `/restart` declare `key: 'ctrl-c'` (etc.) like any
  other command, with a comment above `key:` telling a programmer that
  the key is really caught by the emergency path: raw stdin is scanned
  in `src/client/emergency.ts` and the action handled synchronously in
  `src/client/terminal.ts` before any key decoding, so changing `key:`
  in the command file changes only what `/keys` shows, not what the
  key does. There is no `emergency` flag; the key dispatcher simply
  never sees those keys.
- **Not commands**: prompt-editing keys (ctrl-a, ctrl-k, alt-left,
  undo…) stay rows in `key-help.ts`; they act on the text, not the
  session. So do keys whose meaning depends on the state: esc (pause,
  but also leave editing and close a picker) and enter. `/keys` keeps
  its sections; a command key's row reads `ctrl-m  /model  <description>`.
- **Web**: binds a command key only if the browser gives it to the
  page (not ctrl-t, ctrl-w, ctrl-n); `/keys` on the web lists only the
  keys the web really has.

## Provenance

A command or prompt an agent sends must work exactly as if the user had
typed it: another session saying `/go 28` to tab 30 does the same thing,
broadcast to every client of that session. How commands that change a
client view (switching tabs) get there is decided later, but it must be
possible, even at 10–50 lines of cost.

Decided with task 0x for modals: a command's reply may carry
`open: '<modal>'`; the host then broadcasts that modal's data as an
event to every client following the session, and each client opens
the modal on receiving it. `/model` alone broadcasts `models { current,
items }`, so a `/model` sent by another session opens the picker for
whoever watches that tab. A client-only opening (Ctrl-M) asks with
the `models` protocol command and gets the same event to itself;
nothing is recorded. A future view change (switching tabs) can use the
same shape.

It must never be disguised: history records who sent each prompt and
command. "You" means the human typed it; anything else shows as, for
example, "You (sent from 123-xyz)".

## Approval

The host checks each tool call before running it against a list of
dangerous patterns (`rm -rf` and friends; not plain `rm -f`, which
models overuse and which is rarely dangerous). A match asks y/N (default
No), showing the call with the matching part highlighted. One setting
picks the policy: `security: 'best-effort'` (ask on matches) or `'none'`
(never ask). Best effort by name: there is no sandbox, and patterns
don't stop a determined model.

## Modals

Client-only UI that is not part of the session: Ctrl-M model picker,
/login, /config, Ctrl-F find/filter. Never in history. A modal reads data
from the host and ends in an ordinary command.

Terminal rendering: the modal is composited into the frame. Rows keep
the transcript to its left and right, then one blank column, an outline
and the contents. The diff renderer treats it like any frame change; no
extra terminal state is needed. (The old Hal blanked whole rows.)

Height is fixed while open: 80% of the rows, at most 50. Contents
scroll. Typing into a search box never changes the height.

## Model picker (later task for the tree)

```
Current model: anthropic/claude-opus-5-5:high
Search: opu_
Models:
  > hal/
  > openai/
  v anthropic/
      > fable
      v opus (default: opus-5-5)
*         5.5   Opus 5.5 (anthropic/claude-opus-5-5)  <- default
          5.0   Opus 5 (anthropic/claude-opus-5)
Thinking: [xxxx ] high  (left/right: change)
```

The first picker is a plain filtered list with ranking that works
(`opus-5.5` finds claude-opus-5-5 first).

## Find / filter (later task)

```
Find / Filter (esc: dismiss, enter: find, up/down: navigate)
Find: ______
Show:
[ ] tool calls
[ ] thinking
[x] discussion (user/assistant messages)
[x] crosstalk (messages to/from other sessions)
```

The Enter hint changes to "toggle" on the checkboxes. Find searches
across tabs (host); filtering changes only this client's view.

## Terminal and web

They should look and behave alike, but they don't share rendering:
lines and escape codes are not DOM. Shared, in `src/common`:
- what to show: transcript items, session state, forms and their
  current values and focus;
- behaviour: key handling for the prompt and forms, as pure functions of
  (state, key) → state, so Enter, Escape, arrows and Tab mean the same
  in both.

Each client only maps that to its medium (terminal rows, DOM elements).
A feature is done when both clients have it, unless its task says
otherwise.
