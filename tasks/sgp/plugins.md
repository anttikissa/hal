# Writing plugins

Plugins have the full power of their Hal process. Keep project effects
local by convention; use global hooks when that is the intended behavior.
The loader owns hooks and restores them on removal. Return a cleanup
function for timers, watchers, listeners, and other resources you create.
Cancel or disregard pending asynchronous results after cleanup.

## Portable files

Use imports such as `hal/host/plugins.ts`, `hal/host/paths.ts`, or
`hal/common/colors.ts`. These refer to the running Hal, not a source tree
beside the plugin. Include the `.ts` extension. `paths.home()` and
`paths.stateDir()` give this machine's Hal paths; `import.meta.dir` is the
plugin's directory. Do not bake in another machine's absolute paths.

`export const portable = true` opts a file into existing `/plugin-sync`
review. Sync transfers that file and its history, not its imported helpers,
assets, installed programs, or private state. A self-contained file can
use Bun, Node, and the running Hal. Other dependencies must exist on both
machines. Portable means eligible to sync, not guaranteed compatible with
every Hal version or operating system.

Both host and terminal processes load Hal-home plugins and personal
`~/.agents/plugins/hal/*.ts` files. Choose targets or runtime checks
appropriate to the process; avoid starting the same background service in
both. See [personal discovery and sync](../0xy/personal-plugins.md).
Trusted project plugins in `.agents/plugins/hal` load in the host while an
open tab needs their directory. See
[project trust and lifetimes](../tzr/project-context.md).

A load error leaves the source unchanged and removes its hooks. Repeated
filesystem events for the same failed bytes do not rerun setup. An edit or
restart retries it. One machine failing to load a plugin is not a request
to delete the file on the other machine.

## File-local behavior

Use ordinary `around()` with `pluginFiles` from
`hal/host/plugin-files.ts`. No extra registry or mandatory scope:

```ts
import type { Plugin } from 'hal/host/plugins.ts'
import { pluginFiles } from 'hal/host/plugin-files.ts'

export const portable = true

export default (plugin: Plugin) => {
  plugin.around(pluginFiles, 'transform', async (next, path, text, ctx) => {
    const result = await next(path, text, ctx)
    if (!pluginFiles.within(ctx.cwd, path) || !path.endsWith('.ts')) return result
    return result.trimEnd() + '\n'
  })
}
```

This example deliberately uses the acting session's directory. Pass a
fixed project root instead to follow the destination files regardless of
which session edits them. `within(root, absolutePath)` tests lexical path
containment, including the root itself. Canonicalize paths with
`fileChanges.canonical` when symlink destinations matter. It is a filter,
not a security boundary.

`transform(absolutePath, text, ctx)` runs on changed or newly created EDIT
text, before any batch writes. It returns the final text. Hal computes
diffs, versions, verification, and rollback from that text. A failure
leaves the batch unwritten. Deletions and rollback bypass transforms.
Shell writes and external editors cannot be transformed before writing.

`changed(files, ctx)` runs after EDIT or declared Bash changes have been
recorded and file locks released. Wrap it with an async `around()` for
linters and counters; call and await `next(files, ctx)` to compose. File
paths are relative to `ctx.cwd`; resolve them before applying `within`.
A null before/after snapshot means creation/deletion. Other snapshots may
contain metadata instead of readable content. An observer failure is
reported by the calling tool; it does not undo completed writes.

This is not a whole-filesystem watcher. To observe external edits, use a
watcher and return its cleanup. Debounce expensive work and avoid reacting
to your own unchanged output. Helpers do not restrict native APIs or
other hooks.
