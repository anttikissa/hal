# Pi command extensions

`extras/pi-compat.ts` adapts explicitly selected, trusted Pi command extensions.
It runs the published **pi-simplify 0.2.3** JavaScript unchanged, without Pi's
runtime packages. Commands, help, completion and notices use Hal's existing
host paths for terminal and web.

## Setup

Download the pinned package into a private directory, without installing its
peer dependencies or running package scripts:

```sh
npm pack pi-simplify@0.2.3 --ignore-scripts
tar -xzf pi-simplify-0.2.3.tgz
```

Review `package/dist/*.js`. Create `plugins/pi-simplify.ts` in the Hal home,
substituting your reviewed package's absolute path:

```ts
import type { Plugin } from '../src/host/plugins.ts'
import { install } from '../extras/pi-compat.ts'

export default (plugin: Plugin) => {
    const simplify = require('/absolute/path/to/package/dist/index.js').default
    return install(plugin, simplify, { simplify: ['--staged', '--ref='] })
}
```

Use `/simplify`, `/simplify --staged`, or `/simplify --ref=HEAD~1 src/file.ts`.
`/help simplify` lists its options. `/plugins disable pi-simplify` unloads it;
reload the wrapper after changing its package. No package is loaded by default.
Imported code has the host's OS permissions; this adapter is not a sandbox.

## Supported slice

- Synchronous factory and `registerCommand`: description, async handler and
  synchronous `getArgumentCompletions`. The wrapper can supply missing options.
- Invocation-local `ctx.cwd` and durable `ctx.ui.notify`.
- `exec(command, argv, {cwd?, timeout?, signal?})`: no shell, captured stdout,
  stderr, exit code and killed flag. Timeout is milliseconds, 30 seconds by
  default. Spawn failures, timeout and cancellation reject with output;
  nonzero exits are reported and returned for the extension to handle.
- `sendUserMessage(text, {deliverAs: 'followUp'})`: literal prompts with command
  provenance, queued after busy/paused work or started immediately when idle.
- Pause and unload cancel the invocation's subprocess groups and prevent late
  messages. Finished invocations retain no session history in the adapter.

Other Pi APIs, UI components, events, tools, providers and initialization-time
execution are unsupported and report errors. Extensions must await their work;
background callbacks cannot submit prompts after the command finishes. Arbitrary
extension JavaScript cannot be forcibly canceled by the adapter.

`pi-simplify` asks the model to **edit** changed lines and run tests. Upstream
falls back to `HEAD~1` when a diff is empty or fails, even with `--staged`;
it omits untracked/deleted-only files and splits arguments on whitespace.
The adapter preserves that behavior but makes Git failures visible. The
extension runs one hunk query per changed file concurrently, so 10× files
means 10× subprocess calls; no polling or persistent per-session cache is added.
