# Rebuilding Hal with tsk

Plan for rewriting Hal from scratch, one small task at a time, using
[tsk](https://github.com/anttikissa/tsk) (installed from the `/root/tsk` checkout
via its `./install`; `tsk help` lists commands).

## Goals

- Rethink the architecture: simpler and more robust than today's Hal, without the
  cruft it has accrued (~24k core lines, ~2.4k web client, ~23k test lines,
  ~1,460 commits since March 2026).
- Every line of code is accountable: it maps back to a task, so we can see which
  features the lines come from.
- The user reviews every spec by hand, questions its assumptions and simplifies it
  before it gets implemented.

## Setup

- The current Hal stays where it is and keeps being maintained. It is reference
  code to read, not a source of tasks to copy one-to-one.
- The new Hal is a separate project next to it (name TBD, e.g. `/root/hal2`),
  with its own `tasks/` created by `tsk init`.
- Tasks are written directly in the new project as `planned`. Copy a feature from
  the old Hal only after questioning it; most will change on the way over.

## Workflow

Grow the task graph a small slice at a time instead of writing up all of the old
Hal first:

1. Write the next few tasks (title + description of *what* to build, not how).
2. The user reviews and simplifies them.
3. Implement one ready task (`tsk ready`), test-first.
4. `tsk done <id>` in the same commit as the implementation.
5. Repeat.

`tasks/README.md` holds the guidance shared by all tasks. It starts almost empty
and grows a rule only when a task actually needs it; don't copy today's
`AGENTS.md` wholesale, since that would carry the cruft along.

## First slice: an echo prompt

No provider connectivity, just a readline-like loop:

- **Project setup**: Bun + TypeScript, a `./run` launcher, and `./test` running
  tests, typecheck and lint.
- **Echo prompt**: `./run` shows `> `, reads a line, prints it back and repeats.
  Ctrl-C and Ctrl-D exit and restore the terminal.
  - Open question: handle keys ourselves (raw mode) from day one? Typing,
    Backspace and Enter are all the next slice needs. The terminal's built-in
    line editing would be less code, but it is thrown away once prompt editing
    arrives.

Then one step at a time: cursor movement and word editing, multi-line input,
history, tabs, and so on.

## Tracing lines to tasks

tsk has nothing for this yet, but Git almost does:

- Every commit names its task in a trailer line, e.g. `Task: 5p`. One task per
  commit, as tsk already asks.
- `git blame` then gives line → commit → task. Adding blame up by task shows
  where every line comes from. This could become a tsk command (e.g.
  `tsk lines`).
- Refactors are the weak spot: they move lines into commits that aren't about a
  feature. Rule: a refactor names the task whose code it changes. If it touches
  everything, the graph is probably missing a shared-foundation task; add one.
- A fresh rebuild from the task graph gives clean attribution by construction.

## Architecture decisions

The expensive choices are the process model and persistence. Today there is a
server plus clients talking over file IPC, sessions are saved to disk, and
several terminals can share one instance; that is probably where most of the
cruft lives. Decide these when a slice first needs them, not up front. With tsk
a late change means reordering tasks and rebuilding, which is cheap early on.

## Rebuild safety

A tsk rebuild (`tsk reset`, then implement again) deletes everything except
`.git/`, `tasks/` and paths in `project.ason`'s `keep`. Only ever do it in the
new project or a throwaway clone, never in the directory a live Hal runs from.

## Lessons to carry over

Hard-won knowledge in the old Hal's docs should become task artifacts or
`tasks/README.md` rules when the matching slice arrives, so the new build doesn't
repeat old bugs:

- `docs/terminal.md`: scrollback, line width, diffing, the fullscreen flag.
- `docs/session-files.md`: persistence layout.
- `docs/web.md`: prerelease Solid 2 rules.

Attach behaviour tests as artifacts only where the spec is exact (ASON, string
width and word wrap, hashline edit remapping). The old Hal's tests are tied to
its implementation and don't carry over.

## Open questions

- Name of the new project directory.
- Raw mode from the first slice or not.
- Whether `tokenhub/` belongs in scope.
