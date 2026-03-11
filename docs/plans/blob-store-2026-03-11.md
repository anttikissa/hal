# Blob store rename plan

Goal: make “blob” the real first-class concept, not just nicer wording.

## Constraints

- Minimal design.
- No backwards compatibility code.
- No migration code.
- Clean break is fine.

## Scope

1. Rename session storage from `blocks/` to `blobs/`.
2. Rename public storage helpers from block/ref language to blob language.
3. Rename message and protocol fields from `ref` to `blobId` where they mean stored payload ids.
4. Rename internal API-only marker fields from `_ref` to `_blobId`.
5. Update TUI/replay/runtime surfaces to use blob ids consistently.
6. Add a generic `read_blob` tool so the model can resolve any stored payload by id.
7. Update tests and docs to match the new vocabulary.

## Out of scope

- Content-addressed storage.
- Migration helpers for old state.
- Renaming the TUI `Block` type itself; that is a display concept, not a storage object.

## Implementation slices

### Slice 1: storage + schema rename

- `state.blocksDir()` -> `state.blobsDir()`
- `makeBlockRef()` -> `makeBlobId()`
- `writeBlock()` -> `writeBlob()`
- `readBlock()` -> `readBlob()`
- `updateBlockInput()` -> `updateBlobInput()`
- message fields:
	- image block `ref` -> `blobId`
	- assistant `thinkingRef` -> `thinkingBlobId`
	- assistant tool entry `ref` -> `blobId`
	- tool_result `ref` -> `blobId`

### Slice 2: runtime/event/UI rename

- protocol event field `ref` -> `blobId` for chunk/tool events
- CLI display blocks carry `blobId` instead of `ref`
- replay/runtime/commands use blob ids end-to-end

### Slice 3: model-facing blob capability

- add `read_blob` tool
- use current session’s blob store
- return structured text for generic blobs
- return multimodal content for image blobs so omitted images can be re-read as images

### Slice 4: wording/docs/tests

- compaction placeholders say `blob` instead of `ref`
- history/compaction text points to `blobs/`
- tests updated to assert blob wording and blob ids

## Notes

- This intentionally breaks old on-disk state that still uses `blocks/` or `ref` fields.
- That is acceptable for this change.
