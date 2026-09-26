# Notes from implementing gj

- `liveFile(path, defaults)` never writes defaults by itself; only
  assignments mark it dirty. To create a file, open with `{}` and
  `Object.assign` the initial data, then `liveFiles.save`. My first
  version passed the metadata as defaults and nothing reached disk.
- For the same reason, load existing metadata with `{}` defaults and
  validate afterwards: defaults would silently fill in missing fields,
  which the task forbids ("reported, not replaced").
- The artifact `sessions.ts` does the opposite of this task: its
  `fixMeta`/`readAson` repair or swallow bad metadata. Don't lift those.
- The artifact names the field `workingDir`; the task says cwd, so the
  stored field is `cwd`. Old fields (currentLog, closedAt, fork data)
  were left out; add them in the tasks that need them.
