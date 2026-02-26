# Overnight cleanup results (2026-02-26)

## What happened

Codex was running across 7 tabs working on UI fixes (prompt padding, tool styling,
tab redesign, etc.). It hit OpenAI rate limits (429) and ran out of tokens mid-edit,
leaving `src/cli/format/index.ts` with truncated code — a function call cut off at
`buildPromptBlockFormatter(termCols` and the entire `pushFragment` body deleted.

## What I found

### Codex completed and committed (already in git history):
- 9+ commits of UI revamp: title bar, tab bar, activity bar, prompt echo, chunk styling
- Bug fixes: selection copy, model command, busy state inference, tab freezing
- All passing tests (303 pass, 0 fail per WHERE-TO-CONTINUE.md)

### Codex left uncommitted:
1. **`prompt.ts` refactored** — changed from `lineStart`/`lineEnd` to `formatText()` API
2. **`horizontal-padding.ts`** — new helper for 1-col side padding on prompt lines
3. **`index.ts` BROKEN** — still referenced old `f.lineStart`/`f.lineEnd` (didn't exist)
4. **Debug log disk pruning** — prunes old files to stay under 2 GiB (addresses the 31 GB issue)
5. **Tool input validation** — guards on read/write/edit for missing path/content
6. **Test harness extensions** — config injection, setup hooks, public halDir

## Commits made (7 total)

### Phase 1: Salvaging Codex's uncommitted work

1. **`c68a4bb` fix: prompt echo padding — use formatText API with horizontal padding**
   - Fixed the critical incompatibility: `index.ts` now calls `f.formatText(text)` instead
     of referencing deleted `lineStart`/`lineEnd`
   - Committed the new `horizontal-padding.ts` and modified `prompt.ts` together

2. **`0a3191b` fix: validate tool inputs before filesystem operations**
   - Early guards for read/write/edit tools
   - Prevents crashes on missing/invalid path or content

3. **`51bf6a4` Extend test harness with config, setup hooks, and public halDir**
   - New `StartHalOptions` with custom config and setup callbacks
   - `halDir` made public readonly for test assertions

4. **`a86acc7` Add debug log disk pruning to cap state/debug + state/bugs size**
   - Automatic pruning of `state/debug/` + `state/bugs/` to 2 GiB (configurable)
   - Oldest files deleted first, active log preserved
   - Includes test and config option `debug.maxDiskBytes`

### Phase 2: Fixing UI bugs from TODO.md

5. **`c6d0eaa` fix: apply style per line for all output, not just chunks**
   - Root cause of "tool output first 2 lines turquoise, rest plain" bug
   - Non-chunk output was wrapping entire content in single STYLE...RESET pair
   - When content had newlines, only first outputLine retained the style
   - Now uses `applyStylePerLine` for ALL output types (matching what chunks do)
   - Also fixes prompt echo and list output brightness inconsistencies

6. **`ece5f13` fix: reject directory paths in write tool to prevent EISDIR errors**
   - Write tool accepted directory paths like `~/.hal`, causing EISDIR from OS
   - Now checks if path is a directory before writing (matches read tool's guard)

### Phase 3: Cleanup

7. **TODO.md and RESULTS.md updated** (this commit)
   - Marked fixed UI bugs as DONE
   - Removed duplicate entries
   - Removed items already implemented (input up/down, tab names, status line, etc.)

## UI bugs — resolution status

| Bug | Status | Fix |
|-----|--------|-----|
| Prompt echo not grey on every line | FIXED | `c68a4bb` — formatText API with padding |
| Tool output first 2 lines turquoise only | FIXED | `c6d0eaa` — applyStylePerLine for all |
| Bright word seams in list output | FIXED | `ff9e104` (Codex) + `c6d0eaa` |
| Prompt initial words brighter | FIXED | `c6d0eaa` — same root cause |
| EISDIR write error on directory | FIXED | `ece5f13` — directory path check |
| Tab activity indicators | OPEN | Not yet implemented |

## Test status
- Quick tests: 152 pass, 0 fail
- No new type errors introduced (71 pre-existing, all ASON type widening)

## Files left around
- `codex-backup/` — backup copies of Codex-modified files (safe to delete)
- `codex-backup-index-ts.diff` — diff of Codex's broken index.ts
- `WHERE-TO-CONTINUE.md` — Codex's session notes
- `docs/plans/prompt-output-padding-fix-2026-02-26.md` — Codex's plan doc
