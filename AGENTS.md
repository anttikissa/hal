Commit automatically. 72-column commit messages. Every commit message
ends with these trailer lines (Task only when a task applies):

    Task: <id>
    Implemented by: <model id, e.g. anthropic/claude-opus-5-5>
    Session: <session id, e.g. 157-cms>

Push and pull (with rabase and autostash - config git to use those by default) all the time; this is being developed on two hosts, connected by github only, and we want latest codes on both.

This repository is managed with `tsk`, a simple task manager. Every feature, performance requirement, or other item that defines a behavioral or qualitative aspecf ot the software, must be tracked down to the task that first implemented it. When you modify a task that is 'done', you must change the code or other files associated with it. And when modifying code, for example fixing bugs, you must change the associated task or make a new one.

The idea: we plan to rebuild the software from the tasks from time to time - thus, any change not backed up with an equivalent change under tasks/ will be lost.

The user works with planning agent (writes tasks) and one or more agents (possibly spawned by the planner) that implement them.

Tasks are living specs for a rebuild from scratch, not one-time
actions. Describe the state a task keeps true, not a step to take: not
"initialise package.json with version 0.1.0" but "package.json holds
the current version: 0.1.0 at first, later the latest release in git
history". Avoid `once`; old files a rebuild needs belong in the task's
artifacts.

Unless you are implementing a task: whenever you change any file for
any reason, update the task that covers that file, so a rebuild keeps
the change. Bug fixes especially must not be forgotten: write the rule
the fix restores into the task's description.

Exception: gitignored files (the user's plugins/, local.ts, auth and
state) are private. They have no task, and nothing about them (their
content, purpose, account IDs, emails, dates, plans) ever goes into
tasks, notes, commits or any other tracked file. If unsure, ask.

Lessons that would help the next implementer (surprises, wrong
artifacts, decisions later tasks depend on) go in the task's `notes`
field in task.ason, a list of strings that `tsk show` prints. Never
put them in separate notes files. Read `tsk help` and the tsk README
before inventing a convention tsk may already have.
Change task fields with `tsk edit`/`tsk add-note`, not by string
surgery on task.ason: long specs are ASON template strings, where a
raw backtick breaks the file. After any hand edit, `tsk show <id>`.

Before changing code, read tasks/README.md: it holds the architecture,
module conventions and invariants (such as the emergency keys) that
every change must keep.

# Tests and how to avoid them

Tests are debt. Every single test will add weight for every future task
to carry. Therefore: be extremely wary when adding tests. Will this test
surely test something that might break? Is running this test expensive?
Is this just some cosmetic thing? Will a one-time test suffice?

Test behavior and invariants, not the implementation. Avoid tests that
assert on source text, repeat a constant or template in the expectation,
or merely restate a one-line function. Keep exact-output tests where the
format is a contract (such as ASON). Don't test nondeterministic model
wording. A test should catch a plausible wrong implementation.

Before adding code, climb the lazy ladder: skip it if it needn't exist;
prefer the standard library; prefer native platform features (Bun,
Web APIs); prefer already-installed dependencies; prefer one line; only
then write the minimum code that works. Strongly prefer no new
dependencies, especially on the host path. Lazy means efficient, not
careless: never simplify away trust-boundary validation, data-loss
handling, security, accessibility or explicit requirements.

Other agents may work in the same tree at once. Stage only your own
changes (never `git add -A` or a whole file holding others' edits), and
never `git checkout`, `git restore` or `git stash` over uncommitted work.
The index is shared too: commit with `git commit <your paths>` (or
check `git diff --cached --stat` first) so files another agent staged
don't ride along in your commit. Avoid parallel work that would touch
the same files; if you are in such a hurry that such parallel work is a must,
use worktrees and handle possible merge conflicts.

Orchestrating: give each implementer a fresh subagent and its own
worktree; it rebases onto origin/main and re-runs ./test before
pushing. Size tasks to finish in ~40–70 requests and under ~150k
context (about $2–4 each); split bigger ones. A coordinator needs one
spawn slot per task it will start: slots don't come back. Measure
with scripts/sloc (non-blank, non-comment, non-test lines) and
scripts/cost <session-id>... (Opus 5.5 list prices).

"Progress report" means this, on one screen, with every number
measured now (git log, `scripts/sloc . HEAD`, `tsk ls`, a test-case
count, `scripts/cost`; `scripts/sloc ~/.hal <rev>` for the old Hal),
never recalled:

1. A map by feature area in a code block: what exists, a 12-cell bar
   (█ done, ░ missing, marked as estimates) and what's missing:
   ```
   FOUNDATIONS  host, takeover, restart, history   ████████████  sturdier than the old Hal
   TOOLS        read · bash · send · spawn · wait  █████░░░░░░░  no write/edit/grep/glob
   ```
2. A timeline in a code block, one line per run, ending "← now":
   ```
   27 Sep 11:38 ──── 18 tasks ──── split files, Solid, editing, tabs   9.5k lines
   27 Sep 21:02 ──── answers to questions 1–82 → 26 tasks             11.3k  ← now
   ```
3. A table against the previous report (source lines, tests, tasks
   done/planned, questions answered), when the old Hal reached the
   same size, and cost since the last report and in total.
4. A short numbered list of what needs the user: decisions, what
   isn't deployed, security items.
