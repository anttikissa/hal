# Notes from implementing p

- The artifacts predate the task wording: they use HAL_DIR,
  HAL_STATE_DIR, an ipc/ dir and paths captured as constants at import.
  The task wants one HAL_HOME, sessions/ + state/, and README wants
  config read at call time (tests flip HAL_HOME per test). Take only
  the chmod-not-mkdir-mode idea (mode is masked by umask; chmod also
  tightens an old loose dir) and formatHomePath.
- Under NODE_ENV=test with no HAL_HOME, the home falls back to
  /tmp/hal-test-home-<pid>. It is a safety net, not cleanup: tests that
  spawn ./run without HAL_HOME leave such dirs behind. Set HAL_HOME to a
  temp dir you delete.
- Redaction: a key pattern containing "token" also hits usage fields
  like input_tokens; it matches "token" but not "tokens" on purpose.
- diag.log assumes paths.init() has run (state/ exists); it throws
  otherwise.
- Shared main.ts: another agent's commit swept up my uncommitted lines,
  and my index-built commit then removed theirs because HEAD had moved.
  Build your main.ts index entry from the current HEAD right before
  committing, and check the commit's diffstat for unexpected removals.
