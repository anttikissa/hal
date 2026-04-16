# Comment audit

## What I checked

I sampled the codebase two ways:

- top comment-density files in `src/`
- repo-wide searches for obvious low-signal patterns such as `Ported and simplified`, `Usage:`, and section-banner comments in small modules

That found a consistent pattern: the worst comments were not wrong, just low-value. They repeated the file name, narrated the next line, or preserved migration history that no longer helps a new reader.

## What is good already

The codebase has many genuinely useful comments. I left these alone:

- platform quirks around `fs.watch`
- comments explaining atomic rename watching
- process / terminal behavior that looks misleading at first glance
- protocol quirks and replay invariants
- width / ANSI handling details

Those comments explain *why* the code looks strange.

## Main problems

1. **Narration instead of explanation**
	- examples: “Text before the attachment reference”, “Save draft to disk”, “Main completion logic”
	- these slow scanning without adding meaning

2. **Archaeology comments in live code**
	- `Ported and simplified from prev/...`
	- useful in a PR, not helpful as a permanent module header

3. **Section banners in short files**
	- fine in large modules
	- noisy in 50–120 line modules where the structure is already obvious

4. **Future-tense comments that age badly**
	- “will be replaced later”, “for now”
	- they describe intent, not current behavior

## Recommendation

Keep comments for:

- invariants
- edge cases
- platform bugs / terminal weirdness
- security boundaries
- protocol repair logic

Delete or rewrite comments that only restate:

- the function name
- the next two lines of code
- old migration history
- obvious section labels in small modules

## High-confidence cleanups applied

- `src/cli/completion.ts`
- `src/cli/draft.ts`
- `src/cli/help-bar.ts`
- `src/mcp/client.ts`
- `src/runtime/context.ts`
- `src/session/attachments.ts`
- `src/session/blob.ts`
- `src/utils/live-file.ts`

The theme of the edits is simple: fewer comments, but the remaining ones now explain non-obvious behavior instead of narrating the obvious.
