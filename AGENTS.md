# Git

Commit automatically. Wrap commit messages at 72 columns. End with
these trailers (Task only when applicable):

    Task: <id>
    Implemented by: <model id, e.g. anthropic/claude-opus-5-5>
    Session: <session id, e.g. 157-cms>

Pull and push frequently: two hosts share work through GitHub. Set pull.rebase=true and rebase.autoStash=true, but use --no-autostash in shared worktrees; never stash uncommitted work. Commit your changes before rebasing; wait if others have uncommitted work.

# Tasks

Use `tsk`. Trace every behavior and quality requirement to its implementing task. Every tracked-file change must implement a task or update one; changing a done task also requires changing its associated files. Bug fixes must record the invariant they restore.

Tasks are the rebuild specification: changes absent from tasks/ will be lost.

The planning agent writes tasks with the user; implementers carry them out.

Tasks describe lasting state, not one-time actions: "package.json holds
the current version", not "initialise package.json at 0.1.0". Avoid
`once`; preserve files needed for a rebuild as task artifacts.

Put implementation lessons (surprises, misleading artifacts, decisions)
in the task.ason `notes` list, never separate notes files. Read `tsk help`
and the tsk README before inventing conventions.
Use `tsk edit`/`tsk add-note`, not string surgery: a raw backtick can
break an ASON template string. After any hand edit, run `tsk show <id>`.

Before changing code, read tasks/README.md for architecture, module
conventions and invariants, including emergency keys.

## Writing specs

Apply Strunk & White: omit needless words. Use plain technical English; remove repetition and empty phrases without weakening requirements.

# Privacy

Gitignored files (plugins/, local.ts, auth, state) are private and exempt
from task tracking. Nothing about them belongs in tracked files,
including tasks, notes and commits. If unsure, ask.
Personal hostnames, IPs, SSH aliases and deployment topology are private even when publicly resolvable.
Keep deployment scripts and instructions local and gitignored;
use reserved example domains in tracked examples. Permission to
operate a host is not permission to publish its configuration.

# Tests

Tests are maintenance debt. Add one only if it catches a plausible regression worth its cost. Omit cosmetic tests and those a one-off check can replace. When unsure, omit.

Test behavior and invariants, not implementation. Avoid source-text assertions, repeated constants or templates, and tests that restate one-line functions. Keep exact-output tests for format contracts (such as ASON). Don't test nondeterministic model wording.

# Code

Climb the lazy ladder: skip unnecessary code; prefer the standard
library, native platform features (Bun, Web APIs), installed dependencies,
one line, then the minimum code that works. Avoid new dependencies,
especially on the host path. Never cut trust-boundary validation,
data-loss handling, security, accessibility or explicit requirements.

# Shared worktrees

Other agents may share the tree and index. Stage only your changes:
never `git add -A` or whole files containing others' edits.
Never `git checkout`, `git restore` or `git stash` over uncommitted work.
Commit with `git commit <your paths>` or inspect `git diff --cached --stat`
first so others' staged changes don't ride along. Avoid parallel edits
to the same files; use separate worktrees if overlap is unavoidable.

## Orchestration

Give each implementer a fresh subagent and its own worktree; it rebases
onto origin/main and re-runs ./test before pushing. Size tasks for
~40–70 requests and under ~150k context (about $2–4); split larger ones.
Reserve one spawn slot per task: slots don't return. Measure with
scripts/sloc (non-blank, non-comment, non-test lines) and
scripts/cost <session-id>... (Opus 5.5 list prices).

# Progress reports

Keep reports to one screen. Measure every number now (git log,
`scripts/sloc . HEAD`, `tsk ls`, a test-case count, `scripts/cost`;
`scripts/sloc ~/.hal <rev>` for the old Hal), never from memory:

1. A feature map in a code block: what exists, a 12-cell bar
   (█ done, ░ missing, labelled as estimates), and what's missing.
2. A timeline in a code block: one line per run, with date, task count,
   changes and source lines; mark the latest "← now".
3. A table against the previous report: source lines, tests, tasks
   done/planned, questions answered; when the old Hal reached the
   same size; cost since the last report and in total.
4. A numbered list of decisions, undeployed work and security issues
   needing the user.

# UI: visible plumbing

Show everything relevant once: identifiers users act on, file paths,
failures and complete output. Omit what nobody reads, such as tool call
IDs, argument types and restated defaults; session files keep them.
A closed tool says concisely what it does; opening it shows the detail
and the whole output. Bash reads like a terminal: `$ command` (`&` when
backgrounded), declared files as "Edits a.ts, src/*.ts", then streaming
output. Show non-default controls, invalid or unfamiliar arguments and
why Hal rejected a call. Use readable text, not JSON/ASON.
