# Personal native plugins

Hal loads `~/.agents/plugins/hal/*.ts` in both its host and terminal
processes, alongside existing Hal-home `plugins/*.ts`. Both directories
hot-reload; their lifetime is the process, not a project tab. Other agent
namespaces and marketplace files are not executable Hal plugins.

Existing Hal-home source files and history remain where they are. Personal
versions share that home's history ledger and content store under names
`personal/<filename>.ts`; legacy names remain `<filename>.ts`. Identical
basenames in the two directories stay independent. Names are identifiers,
not arbitrary paths: only the fixed `personal/` prefix is accepted.

`/plugins` identifies personal files by that same name; completion,
`/plugins disable personal/<file>` and `/plugins enable personal/<file>`
work in both terminal and web clients.

`export const portable = true` makes a loaded file eligible for
`/plugin-sync`. The existing hash checks, ancestry comparison, explicit
review choices and stale-choice rejection apply to both namespaces. A
receiving machine resolves personal names against its own user directory.
No remote project directory is executed or used as a sync destination.
Existing nonportable files are excluded even when the peer offers the same
name. A transferred file becomes eligible after the loader reads its
portable declaration.

The Hal-home `plugins/.syncignore` lists names in either namespace. For
example, `personal/keys.ts` keeps that personal plugin separate without
excluding a Hal-home `keys.ts`. Sync transfers source and version history,
not imported helpers, installed dependencies or private state.

Project trust and tab lifetimes remain separate. A personal directory also
encountered while walking a trusted project's ancestors is not adopted by
the project's lifecycle and stays loaded after its last tab closes.
