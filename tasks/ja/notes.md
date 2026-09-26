# Notes from implementing ja

- Don't copy the artifact's lock scheme (O_EXCL pid file + "is pid
  alive" + unlink). It races on takeover and breaks on pid reuse. An
  flock (via bun:ffi; Bun/Node have no flock) is released by the
  kernel even on kill -9. Never delete or replace the lock file: a
  lock on a new inode doesn't exclude the holder of the old one.
- Bun opens fds close-on-exec, so children spawned by the host don't
  keep the lock alive. Worth re-checking if spawning ever changes.
- A hoisted `function join` in main.ts silently shadowed the
  `join` imported from 'path'. Module-level `join(...)` then started
  joining at import time and failed with a confusing ENOENT on
  host.lock. Don't name exports after imported names.
- Unix socket paths are limited to 103 bytes on macOS. $TMPDIR there
  (/var/folders/...) plus mkdtemp already uses much of that, so keep
  temp home names short in tests.
- Multi-process tests: finish reading each child's stdout before
  cleanup, or pids of grandchildren it reported get missed and leak.
