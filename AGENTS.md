Commit automatically. 72-column commit messages.

The planning agent only writes tasks; it never implements or spawns
agents. The user starts a fresh-context agent for each task (`tsk ready`,
`tsk show <id>`), which works test-first, with `tsk done <id>` and a
`Task: <id>` trailer in the same commit.

Lessons that would help the next implementer (surprises, wrong
artifacts, decisions later tasks depend on) go in the task's `notes`
field in task.ason, a list of strings that `tsk show` prints. Never
put them in separate notes files. Read `tsk help` and the tsk README
before inventing a convention tsk may already have.

Before changing code, read tasks/README.md: it holds the architecture,
module conventions and invariants (such as the emergency keys) that
every change must keep.

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
