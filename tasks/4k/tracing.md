# Local terminal repaint tracing

Disabled by default. Nothing in the normal startup path imports the tracer.
To opt in, add this to the **local terminal client's** gitignored `local.ts`:

```ts
import { redrawTrace } from './src/client/redraw-trace.ts'

// Enable only for this machine's remote terminal client, not its host.
if (process.argv[2] === '-r') {
  redrawTrace.start(new URL('./state/redraw-trace.jsonl', import.meta.url).pathname)
}
```

The `state/` directory must exist. Restart the local client after adding the
configuration. Do not change the remote host's configuration. To disable,
remove/comment the block and restart; an in-process local override can also
call `redrawTrace.stop()`.

Each line is one paint's geometry and causes, including causes coalesced by
throttling. `clear: true` means the renderer generated CSI 3J; `home: true`
means cursor-home. `reason` distinguishes forced rebuilds, shrink, immutable
row changes, ordinary diffs, and unchanged frames. Causes identify event
categories, keyboard handling (not keys), heartbeat, resize, and redraw.
Unclassified protocol events are labelled `event:other`, never copied raw.

The capture contains no transcript, input, output, session identity, paths,
URLs, credentials, or terminal escape strings. It stays local and owner-only;
never commit it. Files append across restarts. A run stops after 20,000 paints
or a write error, without changing rendering; `redrawTrace.state.error` holds
an error locally. Remove old captures when no longer needed. This observes
what the renderer generated, not whether the terminal emulator independently
followed ordinary output or when queued bytes reached the screen.
