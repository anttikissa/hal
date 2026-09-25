Commit automatically. 72-column commit messages.

The planning agent only writes tasks; it never implements or spawns
agents. The user starts a fresh-context agent for each task (`tsk ready`,
`tsk show <id>`), which works test-first, with `tsk done <id>` and a
`Task: <id>` trailer in the same commit.

Test behavior and invariants, not the implementation. Avoid tests that
assert on source text, repeat a constant or template in the expectation,
or merely restate a one-line function. Keep exact-output tests where the
format is a contract (such as ASON). Don't test nondeterministic model
wording. A test should catch a plausible wrong implementation.
