# Local terminal repaint tracing

Disabled by default. Nothing in the normal startup path imports the tracer.
To opt in, create the **local terminal client's** gitignored
`plugins/redraw-trace.ts` with:

```ts
import { mkdirSync } from 'fs'
import type { Plugin } from '../src/host/plugins.ts'
import { redrawTrace } from '../src/client/redraw-trace.ts'

export default (plugin: Plugin) => {
  // This machine's remote terminal client only, not its host.
  if (process.argv[2] !== '-r') return
  plugin.onChange(({ phase }) => {
    if (phase === 'activate') {
      mkdirSync(new URL('../state/', import.meta.url), { recursive: true, mode: 0o700 })
      redrawTrace.start(new URL('../state/redraw-trace.jsonl', import.meta.url))
    } else {
      redrawTrace.stop()
    }
  })
}
```

The plugin loader activates this when the file is added or changed. Importing
or staging it creates no trace file or hooks. Removing the plugin disables
tracing and closes its capture; reloading stops the outgoing capture before
starting the incoming one. A failed staged registration leaves the active
capture alone. No restart or remote-host configuration change is required.
Do not enable an older local.ts tracing block alongside this plugin.

Each line is one paint's geometry and causes, including causes coalesced by
throttling. `clear: true` means the renderer generated CSI 3J; `home: true`
means cursor-home. `reason` distinguishes forced rebuilds, shrink, immutable
row changes, ordinary diffs, and unchanged frames. Causes identify event
categories, keyboard handling (not keys), heartbeat, resize, and redraw.
Unclassified protocol events are labelled `event:other`, never copied raw.

The capture contains no transcript, input, output, session identity, paths,
URLs, credentials, or terminal escape strings. It stays local and owner-only;
never commit it. Files append across reloads/restarts. A run stops after
20,000 paints or a write error, without changing rendering;
`redrawTrace.state.error` holds an error locally. Remove old captures when no
longer needed. This observes what the renderer generated, not whether the
terminal emulator independently followed ordinary output or when queued
bytes reached the screen.
