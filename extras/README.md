# Extras

Ready-made plugins (task ybg), off until you select one. To enable
`extras/<name>.ts`, create the private `plugins/<name>.ts`:

    export { default } from '../extras/<name>.ts'

Delete that file to turn it off. Changes to an extra itself take effect
when the host restarts.

- `multiedit.ts`: block-format EDIT (`!!OLD`/`!!NEW`/`!!END`) that
  replaces core EDIT and WRITE with one atomic batch. Strict parser.
- `edit-quirks.ts`: EDIT parser leniency for the models listed in its
  `quirks` table; others get multiedit's strict errors. Each firing is
  logged to `state/diag.log` with its model, so you can delete quirks
  nobody uses. Needs `multiedit.ts`.
