# Notes from task b

- old-AGENTS.md's Configuration section (config.ason, config-template,
  `config` objects merged with Object.assign) does not apply here. This
  project uses config functions on module objects plus local.ts instead.
  The startup and module-object rules in that file still apply.
- The layer check in src/conventions.test.ts looks only at relative
  imports. Bare specifiers (`fs`, `node:*`, `bun:*`, packages) are not
  checked, so a host-only import in src/common/ still passes. Keeping
  common browser-safe depends on review alone.
- The side-effect test imports every non-test module, main.ts included,
  in a `bun -e` subprocess with a 5 s timeout. If it fails with a null
  or nonzero exit code and no output, look for a module that starts a
  timer, watcher or socket at import time.
- It scans only src/, so the repo-root local.ts is not covered by it.
