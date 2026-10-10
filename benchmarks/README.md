# Benchmarks

This is the canonical benchmark workspace. Only this document, AGENTS.md and
`fetch` are tracked. All other contents are ignored by default.

- `.cache/`: lazily acquired, revision-pinned external projects.
- `local/`: preserved local benchmark labs and historical records.
- Other results, logs, fixtures, dependencies and local configuration stay ignored.

Acquire a missing project only when needed:

```
./benchmarks/fetch --name suite --source <git-url-or-local-repository> --ref <full-commit>
```

The helper prints the cache path. It reuses an exact revision and rejects a
mismatched cache without overwriting it. Dependencies are installed inside the
ignored benchmark workspace, not Hal's runtime. Paid model calls are separate
from acquisition and need explicit authorization.

The user and planning agent agree the run-record schema separately. Keep complete
failure evidence; report API-equivalent cost, actual spend and subscription quota
as distinct measurements. A missing quota snapshot is not a zero-percent result.
