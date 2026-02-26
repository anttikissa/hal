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

## What I did

### Commits made (4):

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

### Test status:
- Quick tests: 152 pass, 0 fail
- No new type errors introduced (all remaining tsc errors are pre-existing ASON type widening)

## Still remaining (not touched)

- `TODO.md` has uncommitted edits (Codex updated task descriptions) — left as-is
- `WHERE-TO-CONTINUE.md` — Codex's session notes, left for reference
- `codex-backup/` — backup copies of all modified files before any changes
- `docs/plans/prompt-output-padding-fix-2026-02-26.md` — Codex's plan doc

## Open UI bugs from TODO.md

These are still listed as unresolved:
- Tool call turquoise coloring bug (first 2 lines bright, rest not) — screenshot at `/tmp/hal/images/8258sp.png`
- Prompt echo showing brighter initial words — screenshot at `/tmp/hal/images/7heiwj.png`
- Tab activity indicators (!, ?, *, checkmark) not yet implemented
- Bright word seams in list output — screenshot at `/tmp/hal/images/mkm576.png`
