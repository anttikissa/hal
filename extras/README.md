# Extras

Ready-made plugins (task ybg), off until you select one. To enable
`extras/<name>.ts`, create the private `plugins/<name>.ts`:

    import type { Plugin } from '../src/host/plugins.ts'
    import extra from '../extras/<name>.ts'

    export default (plugin: Plugin) => {
    	return extra(plugin)
    }

`/plugins disable <name>` and `/plugins enable <name>` toggle it; a bare
`export { default } from …` has no body for them to edit. Changes to an
extra itself take effect when the host restarts.

- `edit-quirks.ts`: EDIT parser leniency for the models listed in its
  `quirks` table; others get EDIT's strict errors. Each firing is
  logged to `state/diag.log` with its model, so you can delete quirks
  nobody uses.
- `commit-sloc.ts`: shows code lines (no blanks or comments) added and
  removed per file on commit cards, totals them over source files as
  LOC, and rejects background Bash calls containing `git commit` so
  each commit shows in the foreground.
- `codex-hooks.ts` and `claude-hooks.ts`: explicitly trusted command hooks
  and hooks bundled in local plugin packages. See [setup and coverage](hooks.md).
