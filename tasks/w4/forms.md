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
survive restart. Question blocks use colors.question (green, terminal
and web), apart from amber warnings. An active terminal question always shows its fields and
focused choice, even if the question block was cached before it became
answerable. An open question's fields stand between blank rows, apart
from the question text above and the key hint below. A text field's
placeholder is drawn in oklch.faint of the block's colours, like the
prompt's example request: deliberately below the readable-text minimum
so it never reads as typed text (the user's decision). A form marked
`skip` changes Escape from pause to skip: the host records a cancelled
answer and runs the asker again, which moves on; its hint says
"Escape: skip". While a turn's question is open the session is
`blocked (question)` (tasks/j1/states.md). A command's question is not
a state: it sits beside whatever the session does (a turn blocked on a
login, a turn streaming), like the inbox, and never changes the state
or ends the turn. One question is open at a time; a newer one replaces
a command's.

Nothing waits in memory for an answer: whoever asked is re-run with the
answer (a command gets `run(args, answers)`; a tool batch continues).

Real models use the same durable block through the ask tool (task bx);
synthetic models and commands may ask directly. Model questions never request secrets.

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
  in `src/common/emergency.ts` and the action handled synchronously in
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
- **Web forms** never claim Cmd or Ctrl keys: with a question open, the
  shared form keys get only unmodified (or Shift/Alt) keys, so Cmd-R,
  Cmd-L, Ctrl-R and the like keep their browser meaning (user report:
  an open /login ate Cmd-R and Cmd-L).

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

Height is fixed while open: 80% of the rows, at most 36. Contents
scroll. Typing into a search box never changes the height.

## Model picker

```
┌─ Model: anthropic/claude-opus-5-5 ─────────────────────────┐
│ Search: _                                                   │
│   ▶ hal                                                     │
│   ▶ openai  (default: gpt-6.1-sol)                          │
│   ▼ anthropic  (default: claude-opus-5-5)                   │
│     ▼ opus  (default: claude-opus-5-5)                      │
│ >     * 5.5          Claude Opus 5.5 · anthropic/claude-... │
│         5            anthropic/claude-opus-5                │
│     ▶ sonnet  (default: claude-sonnet-5)                    │
│   ▶ openrouter                                              │
└─ ←/→: close/open, enter: pick, esc: cancel ─────────────────┘
```

A tree like the old Hal's: provider (old Hal's order: hal, openai,
anthropic, google, opencode-go, openrouter, then the rest), then the
family when two or more of a direct provider's models share one (opus,
gpt, kimi…; the leaf is the rest of the name, `5-5` shown as `5.5`), or
the vendor for a reseller (openrouter/moonshotai/kimi-k2). A family
lists its two newest versions' flagships; the rest wait in a closed
`older` inside it, and a provider's non-chat and family-less models in
a closed `other`, both last. ▶/▼ mark closed/open categories; it opens
with the current model's categories open and selected (a `✓` marks it;
the selected row is lit in the picker colour behind a `→`).
Right opens the selected category and left closes it or the one the
selection is in, also while searching;
Enter on a category picks its default (the alias's model: gpt →
gpt-6.1-sol, opus → claude-opus-5-5; else a family's or vendor's
newest. Promote a newer GPT default only after verifying it on the
configured account; a
provider has one only through an alias), and on one without a default
opens or closes it. Typing ranks the models (`opus-5.5` finds
claude-opus-5-5 first), shows only the matches with their categories
open, but keeps `older` and `other` closed while their parent has
matches outside them (`gpt` shows gpt's flagships and a closed older;
`gpt 5.5` opens older), and selects a matching category first (`gp` selects openai/gpt,
`opus` anthropic/opus), else the best-ranked model, an alias's model on
a tie (`claude` selects Opus 5.5). The words typed show bold and
bright in the list where a word starts (the `5` of 5.6, not of 15),
by the matcher (common/fuzzy.ts) the find modal reuses. Emptying the search
(Ctrl-U) brings back the tree and the current model. On the web a tap
is Enter.

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
In the terminal a choice's options stand one per row, never side by
side (a long list must not run off a wide screen), under the field's
label if it has one; the chosen one reads `→ name`, lit like a
picker's selected row (colors.popupCurrent of the surrounding fg: a
lighter tint of its hue, grey around neutral text; inverse on
monochrome). Up and down move
through them, left and right alike, without wrapping round; past the
first or last option they move to the field above or below.
On the web an open question is a card like the others (square, lit bar
on the left, its style's tint behind) with a ✕ at its top right that
dismisses it exactly as Escape does; tapping outside does not. Choice
options wrap with the same gap across and down; each is outlined in
the card's colour and the chosen one is solid in it, dark text on top
(no slate buttons, no pale accent). The web's current tab is lit the
same way: a bar in its colour on the left, its tint behind. No glow
anywhere: a card's bar is a plain solid edge.
A feature is done when both clients have it, unless its task says
otherwise.
