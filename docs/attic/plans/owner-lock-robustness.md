# Owner lock robustness

## Problem

Multiple HAL processes can end up thinking they're the owner simultaneously.

### Root causes

1. **`isPidAlive` treats suspended (`T` state) processes as dead.** If the owner is
   briefly suspended (Ctrl-Z, terminal background, OS signal), a client's 5-second
   `tryPromote` poll sees it as dead, `rm`s the lock, and claims ownership. When the
   original owner resumes, it still has `isOwner = true` — never rechecks.

2. **Dead-owner recovery has a TOCTOU race in `claimOwner`.** Two clients can both
   read the lock, both see a dead PID, both `rm` the file, both call `tryClaim()`.
   Only one wins the `open('wx')`, but the other's `rm` can delete the *winner's*
   newly-created lock:
   ```
   Client A: read lock → dead PID
   Client B: read lock → dead PID
   Client A: rm lock → tryClaim() → creates new lock ✓
   Client B: rm lock → DELETES A's lock! → tryClaim() → creates new lock ✓
   ```
   Now A thinks it's owner but has no lock file.

3. **`claimOwner` doesn't recognize its own lock.** When called a second time by the
   same process (e.g., web server retry at `main.ts:351`), it sees the lock exists,
   reads its own PID, finds it alive, returns `{ owner: false }`. This caused the
   confusing `[web] skipped: another owner is active` message.

4. **Owner never validates its lock after initial claim.** If the lock is deleted or
   overwritten by another process, the owner has no way to know. It keeps running
   the runtime and web server indefinitely.

## Fixes

### Fix 1: Owner heartbeat (self-check)

Add `verifyOwnership(ownerId): boolean` to `ipc.ts`. Reads `owner.lock` and returns
true only if it exists and contains our ownerId.

The owner calls this every 3 seconds. On failure:
- Save sessions
- Stop web server
- Exit with code 100 (restart loop re-launches as client, may re-promote)

This also handles the suspended-owner case: after resuming from `T` state, the
heartbeat fires, detects the lock was taken, and the process gracefully steps down.

### Fix 2: Atomic dead-owner recovery (rename instead of rm)

Replace `rm(ownerFile)` with `rename(ownerFile, ownerFile + '.stale.' + pid)`.
`rename` is atomic — only one process can move the file. Others get ENOENT. Then
`tryClaim()`. Clean up the stale file after.

### Fix 3: Recognize own lock in `claimOwner`

After `tryClaim()` fails and we read the lock, check if `lock.ownerId === ownerId`.
If so, return `{ owner: true }` — we already hold it.

## Edge cases

- **Lock file deleted externally** (user, another process, filesystem issue): Owner
  heartbeat detects this within 3s and steps down.
- **Lock file overwritten by another process**: Same — heartbeat detects ownerId
  mismatch.
- **Process suspended for longer than heartbeat interval**: On resume, first heartbeat
  fires, detects lost lock, process exits with restart code.
- **Two clients race to replace dead owner**: Only one wins `rename` + `tryClaim()`.
  The other fails gracefully.
- **Owner crashes without releasing**: Lock has dead PID. Next `claimOwner` call
  detects it via `isPidAlive` and does the rename-based recovery.
