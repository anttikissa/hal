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

- `multiedit.ts`: block-format EDIT (`!!OLD`/`!!NEW`/`!!END`) that
  replaces core EDIT and WRITE with one atomic batch. Strict parser.
- `edit-quirks.ts`: EDIT parser leniency for the models listed in its
  `quirks` table; others get multiedit's strict errors. Each firing is
  logged to `state/diag.log` with its model, so you can delete quirks
  nobody uses. Needs `multiedit.ts`.
