Commit automatically. 72-column commit messages.

The planning agent only writes tasks; it never implements or spawns
agents. The user starts a fresh-context agent for each task (`tsk ready`,
`tsk show <id>`), which works test-first, with `tsk done <id>` and a
`Task: <id>` trailer in the same commit.
