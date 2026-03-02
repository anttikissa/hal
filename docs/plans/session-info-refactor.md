# SessionInfo refactor: one source, one truth

Estimated savings: ~60 lines net deleted.

## Problem

Two types for the same concept (`SessionInfo` vs `SessionMeta`). Data duplicated
across `index.ason` and per-session `info.ason`. Janky bridges (`sessionMetaSnapshot`,
`logNameCache`, `currentLogName`) and read-merge-write in `saveSessionInfo`.

## Plan

### 1. Unify `SessionInfo` — absorb `SessionMeta` fields, delete `SessionMeta`

### 2. Slim `index.ason` — just `{ activeSessionId, sessions: string[] }` (IDs only)
   On load: read index for ordering, read each `info.ason` to hydrate.

### 3. `Map<string, SessionInfo>` in `session.ts` — the one source of truth
   Runtime populates it. `appendToLog` reads `currentLog` from it. `saveSessionInfo(id)`
   writes from it. No args beyond the id.

### 4. Kill bridges — `sessionMetaSnapshot`, `logNameCache`, `currentLogName`, disk-read-merge

### 5. Callers — mutate the in-memory object, call `saveSessionInfo(id)`
