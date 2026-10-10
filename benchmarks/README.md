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

## Historical records

Local records retain original artifacts and reference available full transcripts
and receipts for all tool calls. Import includes identifiable failed and aborted
attempts, deduplicates stable source identities, and marks missing metadata unknown.
Different suites and tasks stay distinct. Historical feature labels describe
what actually ran, not what is installed today.

From this directory, the preserved local import and query helpers run with Bun:

```
bun local/records/import.ts
bun local/records/query.ts --matched
bun local/records/query.ts --suite stockroom-11 --latest
bun local/records/query.ts --failures --json
bun local/records/query.ts --slow --json
bun local/records/query.ts --timeline
```

The append-only ledger is `local/records/ledger.asonl`. Reimporting unchanged
sources adds no attempts; metadata revisions supersede earlier records without
rewriting history. Queries resolve revisions without counting them as new runs.
All artifacts and local helpers remain ignored. JSON output retains detailed
configuration, cost provenance and references for inspection or graphing.

Compare matching model/effort configurations separately from practical model
trade-offs. Reports show sample sizes, uncertainty, recurring failures, slow calls
and version associations. Single samples do not establish confidence intervals;
version correlations do not establish causation.

API-equivalent cost includes dated pricing provenance and remains separate from
actual spend and subscription quota. Missing quota snapshots are not zero usage.
New runs check concurrent subscription use before starting and capture quota
before/after; overlapping activity or reset boundaries qualify the inference.
Preserve existing records until a retention policy is agreed. Importing and
querying historical results never authorizes new paid model calls.
