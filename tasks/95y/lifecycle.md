# Plugin directory lifetimes

`plugins.activateDirectory(path)` loads an existing directory's top-level
TypeScript plugins and watches changes. It returns a promise for the initial
scan. Repeated calls share the same activation; they do not acquire references.
The caller owns session counting and trust checks.

`plugins.deactivateDirectory(path)` stops that directory's watcher, removes
its hooks, and runs each plugin's returned cleanup. Other directories stay
active. Pending imports cannot register after deactivation; a pending scan
cannot resume into a later activation. Imported top-level code cannot be
canceled: put operational work in the registration function, with cleanup.

Both functions are ordinary hookable module functions. Use `around` and await
`next(path)` to observe completed activation. Deactivation removes hooks
synchronously; asynchronous cleanup rejections are reported but cleanup is
not awaited. Keep cleanup repeat-safe and cancel your own background work.

Paths are resolved to absolute paths, not canonicalized through symlinks.
Discovery callers must use a consistent canonical spelling. Missing directories
are not created by activation; failure rejects and releases that activation.
A later call can retry.

Files compose by basename, then full path, then registration order. A duplicate
basename in another directory neither replaces nor owns the first file's hooks.
Only the Hal-home plugin directory participates in the existing history and
reviewed sync; activating another directory does not export its files.

Project discovery and last-session reference counting belong to task tzr.
These loader functions do not automatically discover or trust projects.
