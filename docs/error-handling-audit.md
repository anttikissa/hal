# Error-handling audit

## Scope

I reviewed repo-wide `try/catch`, empty catches, and promise `.catch(...)` fallbacks with a bias against defensive code that hides real failures.

## Good patterns worth keeping

These catches are boundary-facing and intentional:

- **Missing-file probes**
	- `runtime/context.ts`, `ipc.ts`, and similar code often checks whether a file exists by trying to read it.
	- Returning `null` / skipping to the next candidate is correct there.
- **Best-effort cleanup**
	- `watcher.close()`, shutdown-time process kills, and abort handlers should not crash shutdown paths.
- **Transient parse helpers**
	- provider retry-delay parsing and JWT decoding should fail soft and fall back to "no parsed metadata".
- **HTTP body fallback reads**
	- `res.text().catch(() => '')` in auth/usage paths is acceptable when the real error is the HTTP status and the body is only extra context.
- **Optional platform integrations**
	- clipboard helpers and similar OS-specific conveniences can fail without invalidating the main operation.
- **Watcher reload loops**
	- `live-file.ts` watcher reloads can see half-written files during editor save cycles; retrying on the next change is better than surfacing noisy transient errors.

## Bad patterns found

The main weak spots were not "too many catches" but **catches that hid durable local state bugs**:

1. **Draft persistence hid write failures**
	- `saveDraft()` emitted `draft_saved` even when the file write failed.
	- `clearDraft()` could also emit success after an unlink failure.
	- Result: other clients could be told a draft changed when disk state never changed.

2. **Client state silently reset on corruption**
	- invalid `client.ason` fell back to defaults with no signal.
	- Result: users lose startup state and the code gives no clue why.

3. **Startup fire-and-forget failures were fully silent**
	- runtime startup swallowed failures from model refresh and dynamic imports for MCP / inbox.
	- Result: features disappear quietly and debugging becomes guesswork.

4. **IPC lock corruption was hidden**
	- non-ENOENT failures while reading/removing `host.lock` were swallowed.
	- Result: host-election problems could look like "nothing happened".

## High-confidence fixes applied

- `src/cli/draft.ts`
	- log explicit errors for draft save/load/clear failures
	- do **not** emit `draft_saved` unless the disk change actually succeeded
	- still ignore the benign ENOENT race during delete
- `src/cli/draft.test.ts`
	- coverage for failed save, failed clear, and corrupt draft parse
- `src/client.ts`
	- invalid `client.ason` now logs a clear error before falling back to defaults
	- failed writes to `client.ason` now log explicitly
- `src/client-startup.test.ts`
	- coverage for corrupt client state fallback + logging
- `src/ipc.ts`
	- non-ENOENT host lock read/remove/release failures now log explicitly
	- plain missing-file cases still stay quiet
- `src/server/runtime.ts`
	- startup now logs failures from model refresh and failed MCP/inbox module imports

## Recommendation for future edits

Use this rule:

- If the catch handles an **expected boundary condition**, keep it narrow and quiet.
- If the catch handles a **local invariant failure** or **persistent state corruption**, log it or throw.
- Never emit a success event after a failed disk write.
- Prefer filtering only known-benign cases like `ENOENT`; do not blanket-swallow everything.

## Cases I intentionally left alone

- `runtime/inbox.ts` malformed message cleanup and fs.watch→poll fallback
- `live-file.ts` watcher reload parse failures during atomic editor writes
- provider metadata parsing helpers
- auth/usage `res.text().catch(() => '')` body best-effort reads
- cleanup-only shutdown catches

Those are defensive, but they sit on real boundaries and do not hide primary control flow failures.
