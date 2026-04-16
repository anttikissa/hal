# LOC reduction plan for `src/utils/ason.ts`

## Current size

- `bun cloc src/utils/ason.ts` reports **417 LOC**.
- That makes it one of the larger utility modules, and it is carrying both core ASON syntax work and ASONL/stream framing.

## What is mixed together today

- Public ASON types and export surface (`AsonValue`, `AsonArray`, `AsonObject`, `ason`, default export, `ParseError` type export)
- Smart/stringified formatting
- Comment-aware object/array pretty-printing
- Parser token scanning and whitespace/comment skipping
- Number/string/key parsing
- Parse error formatting with line/column caret output
- Multi-value parsing (`parseAll`)
- Byte-stream to line framing (`streamLines`)
- ASONL record parsing over streams (`parseStream`)

That is at least three concerns in one file:

- core ASON syntax
- comment-preserving pretty-printer/parser
- ASONL/stream framing for logs and IPC

## Plausible reduction ideas

### 1) Delete clearly unused surface

- Remove the `ParseError` class and `export type { ParseError }`.
	- In-repo search shows no consumer of `ParseError`, and nothing reads `err.pos`.
	- Tests assert error message text, not class identity.
	- Replacement options:
		- throw a plain `Error`
		- or `Object.assign(new Error(msg), { pos: ctx.pos })` if the `pos` field is still wanted internally
	- Estimated impact: **-7 to -12 LOC** in `ason.ts`, plus a tiny doc/export cleanup.
	- Risk: only external API consumers outside this repo.

- Remove `export default ason`.
	- In-repo search found named `ason` imports, not default imports.
	- Estimated impact: **-1 LOC**.
	- Risk: only external consumers.

- Re-evaluate whether `parseAll()` needs to stay public.
	- Production usage appears to be only `src/server/sessions.ts`; the rest is tests.
	- If that single caller can inline a tiny loop or switch to a more local helper, this API can disappear.
	- Estimated impact: **-8 to -12 LOC** here, but repo-net savings are probably only **-3 to -8 LOC** after caller/test rewrites.
	- Risk: public API churn, docs churn, and low upside. Not a first-pass item.

- Re-evaluate whether `parseStream()` belongs in the core syntax module.
	- Production usage appears to be `src/ipc.ts`; the rest is tests.
	- This is ASONL/log framing, not core syntax.
	- Estimated impact: **-15 to -30 LOC** in `ason.ts` if moved out.
	- Repo-net impact depends on where it lands:
		- neutral if just moved
		- good if combined with shared stream-line dedupe elsewhere
	- Risk: current e2e failure already spans `tail-file.ts` + `parseStream()`, so ownership changes need good integration coverage.

### 2) Simplify duplicated stringify logic

- Merge the array/object multiline-vs-inline formatting pattern into one helper.
	- Today both branches do the same work shape:
		- gather comments
		- render inline items/pairs
		- width check
		- compute child indent
		- prepend comment block
		- join with commas
	- A helper like `stringifyCollection(...)` or `stringifyEntries(...)` should remove repeated width/indent boilerplate.
	- Estimated impact: **-15 to -25 LOC**.
	- Risk: comment indentation and width heuristics must stay byte-for-byte compatible with tests.
	- Tests to watch:
		- wide object/array wrapping
		- nested inline vs multiline decisions
		- comment-preserving stringify cases

- Consider collapsing `quoteKey()` into the object stringify path if the generic collection helper makes it redundant.
	- Small win only.
	- Estimated impact: **0 to -2 LOC**.
	- Risk: none if readability stays good.

### 3) Simplify duplicated parse loop logic

- Merge `parseObject()` and `parseArray()` loop structure.
	- They currently duplicate:
		- leading `skipWhite()`/comment capture
		- close-delimiter check
		- value parse
		- trailing comma / closing delimiter handling
		- comment metadata storage
	- A generic `parseDelimited(...)` helper can own the loop while object/array-specific code handles item decoding and metadata sink.
	- Estimated impact: **-12 to -20 LOC**.
	- Risk: preserving exact error strings like `Expected ',' or '}'` / `Expected ',' or ']'`.
	- Tests to watch:
		- missing comma in objects/arrays
		- trailing comma acceptance
		- comment attachment to next key / sparse array comments

- If a fully generic helper feels too abstract, a smaller helper just for the post-item delimiter handling still buys some reduction.
	- Estimated impact: **-5 to -8 LOC**.
	- Lower risk than a full generic parser loop.

### 4) Simplify literal parsing in `parseAny()`

- Replace the long `if` ladder with a `switch` on the first character plus a tiny keyword helper.
	- Especially for `true` / `false` / `null` / `undefined` / `NaN` / `Infinity`.
	- Signed `+Infinity`, `-Infinity`, `+NaN`, `-NaN` handling can share one branch.
	- Estimated impact: **-6 to -12 LOC**.
	- Risk: the current mistyped-keyword error messages are good; preserve them.
	- Tests to watch:
		- signed special numbers
		- `mistyped keywords`
		- `unexpected token`

### 5) Simplify string escape decoding

- Replace the long `else if` chain in `parseString()` with a compact `switch` or simple escape table for the common escapes.
	- Keep dedicated branches for:
		- CRLF / line-continuation swallowing
		- `\xNN`
		- `\uNNNN`
		- backtick `${` rejection
	- The current version is correct but verbose.
	- Estimated impact: **-8 to -15 LOC**.
	- Risk: high-value parser behavior lives here.
	- Tests to watch:
		- all escape tests
		- invalid hex/unicode escapes
		- backtick multiline and escaped `${`
		- string continuation cases

### 6) Simplify whitespace/comment scanning

- Extract tiny shared predicates like `isLineBreak()` / `isSpace()`.
	- These can be reused by `skipWhite()`, `fail()`, and string continuation logic.
	- Estimated impact: **-4 to -8 LOC** if done carefully.
	- Risk: Unicode whitespace coverage is easy to regress.
	- Tests to watch:
		- form feed / vertical tab
		- NBSP / BOM
		- `U+2028` / `U+2029`
		- caret alignment with tabs

- Alternative: use a compact string-membership check for non-newline whitespace instead of the long explicit comparison chain.
	- Estimated impact: **-2 to -4 LOC**.
	- Risk: tiny performance hit, probably irrelevant here.

### 7) Reduce number-parser branching only if needed

- The number parser is now larger mostly because it supports:
	- bigint
	- hex
	- numeric separators
	- leading-dot / trailing-dot numbers
	- signed special values
- There may be room to combine bigint regexes or unify post-processing, but this is not the first place to optimize for LOC.
	- Estimated impact: **-4 to -10 LOC**.
	- Risk: high. Numeric grammar bugs are easy to introduce and hard to spot.
	- Tests to watch:
		- every underscore/bigint/hex/exponent case
		- invalid bigint float/exponent
		- double-dot and bare-sign invalid forms

### 8) Move ASONL framing to a more appropriate owner

- `streamLines()` and `parseStream()` are not really about ASON syntax; they are about newline-framed transport.
- Plausible homes:
	- `src/ipc.ts` if we want the framing to stay IPC-specific
	- `src/utils/tail-file.ts` if we want “tail file -> records” in one place
	- a shared stream helper if we want repo-wide dedupe
- For `ason.ts`, this is the cleanest conceptual shrink.
	- Estimated impact in this file: **-20 to -35 LOC** if both helpers leave.
	- Repo-net impact:
		- **neutral** if only moved
		- **good** if a shared helper replaces repeated decoder/buffer/newline loops elsewhere
	- Risk: `parseStream` semantics are subtle:
		- skip blank lines
		- ignore only the first parse error
		- emit immediately on newline-terminated records
		- still parse a trailing non-newline final record
	- Tests to watch:
		- all `parseStream` tests
		- `src/utils/tail-file.test.ts`
		- `tests/ipc.test.ts`, `tests/main.test.ts`, `tests/tabs.test.ts`

### 9) Dedupe stream-line parsing with other modules

This is the strongest cross-file reduction opportunity.

- The same `TextDecoder + buffer + split('\n') + keep trailing fragment` loop exists in:
	- `src/utils/ason.ts`
	- `src/providers/anthropic.ts`
	- `src/providers/openai.ts` (multiple SSE parsers)
	- `src/mcp/client.ts`
	- possibly more places that do chunked line splitting
- A shared newline-framing helper could reduce repo-wide LOC while also letting `ason.ts` drop transport logic.
- Estimated repo-net impact: **-20 to -40 LOC** across those files, possibly more if both OpenAI parsers share it.
- For `ason.ts` itself, impact is usually **0 to -5 LOC** if it still calls a shared helper, or **-20 to -35 LOC** if ASONL streaming moves out completely.
- Risk: different callers trim differently (`trim()` vs `trimEnd()` vs raw lines), so the helper must stay low-level.

### 10) Smaller cleanup wins

- Inline `quoteKey()` if the collection helper makes it one-use.
	- Estimated impact: **0 to -2 LOC**.

- Collapse tiny wrappers if they stop earning their keep after refactors.
	- Example candidates: `peek2()`, maybe `eat()` shape if parser flow changes.
	- Estimated impact: **0 to -4 LOC**.
	- Risk: these helpers currently make parser code readable, so this is not worth doing alone.

- Keep the `ason` namespace export, but do not add more duplicate export surface.
	- Future work should prefer one public shape, not multiple overlapping ones.
	- Estimated immediate impact: **tiny**.

## Ideas I would *not* lead with

- Dropping comment preservation.
	- It would cut code and a lot of tests/docs, but `live-file.ts` depends on it for round-tripping human-edited files.
	- Too high-risk for the value.

- Dropping JS-like extras such as bigint, backticks, numeric separators, or `undefined`.
	- Yes, this would cut substantial code and tests.
	- But the format is explicitly positioned in `docs/ason.md` as a JS-friendly superset.
	- This would be a product decision, not a cleanup refactor.

- Splitting the file without actually deleting logic.
	- That makes ownership cleaner, but repo `cloc` barely changes unless paired with real deletion/deduplication.

## Risks and tests to watch

### Highest-risk behaviors

- Comment attachment semantics
	- object comments attach to the next key
	- array comments are sparse per index
	- blank lines before comments survive roundtrip

- Error quality
	- exact line/column
	- tab-aware caret alignment
	- mistyped keyword diagnostics

- Number grammar
	- hex, bigint, numeric separators, exponents, leading-dot, trailing-dot

- Stream behavior
	- first bad line ignored, later bad lines throw
	- partial record across chunks
	- final record without newline
	- tail-follow integration with `tail-file.ts`

### Test files to keep green

- `src/utils/ason.test.ts`
- `src/utils/live-file.test.ts`
- `src/utils/tail-file.test.ts`
- `tests/ipc.test.ts`
- `tests/main.test.ts`
- `tests/tabs.test.ts`
- `src/server/sessions.test.ts` indirectly via history parsing

### Docs to keep in sync

- `docs/ason.md`

## Recommended execution sequence

1. **Trim dead export surface first.**
	- Remove `ParseError` class/export if we confirm no external dependency.
	- Remove default export.
	- Expected gain: small, low-risk, immediate.

2. **Refactor duplicated collection logic.**
	- First stringify array/object shared formatting.
	- Then parse object/array shared loop handling.
	- This is the best low-to-medium-risk LOC win inside `ason.ts` itself.

3. **Collapse parser ladders.**
	- Simplify `parseAny()` keyword dispatch.
	- Simplify `parseString()` escape dispatch.
	- Only after step 2 so behavior is already stable.

4. **Decide who owns ASONL framing.**
	- If optimizing this file only: move `streamLines()` + `parseStream()` out.
	- If optimizing total repo LOC: introduce one shared newline-framing helper and reuse it in providers/MCP too.

5. **Only then evaluate public API pruning.**
	- `parseAll()` is the most plausible candidate.
	- Do this last because the win is modest and the public churn is larger than the code win.

## Is sub-400 credible?

- **Yes, very credible in one pass.**
- A conservative path without dropping features gets there:
	- dead surface cleanup: ~**8 to 13 LOC**
	- shared stringify helper: ~**15 to 25 LOC**
	- shared parse loop helper: ~**12 to 20 LOC**
	- parser ladder cleanup: ~**6 to 12 LOC**
- That is enough to land roughly around **360 to 390 LOC** without changing the format itself.

## Is a major reduction reachable in one pass?

- **Moderate major reduction, yes**: about **40 to 70 LOC** looks realistic in one focused pass.
- **Huge reduction, no** unless we make a format/product decision:
	- drop comment roundtrip
	- drop JS-compatible extras
	- or move ASONL responsibilities out and also dedupe stream parsing across the repo

## Opportunities that would also reduce other large files

- Shared newline-framing helper can trim:
	- `src/providers/openai.ts`
	- `src/providers/anthropic.ts`
	- `src/mcp/client.ts`
	- and possibly other chunked stream readers
- Moving ASONL/stream concerns out of `ason.ts` can also simplify:
	- `src/ipc.ts`
	- `src/utils/tail-file.ts`
- If `parseAll()` disappears, `src/server/sessions.ts` becomes the sole owner of history-batch parsing, which may also simplify that code path slightly.

## Bottom line

Best practical path:

- delete dead export surface
- dedupe array/object stringify
- dedupe array/object parse loops
- simplify parser dispatch
- then decide whether ASONL framing should stay here

That should get `src/utils/ason.ts` under **400 LOC** without a risky feature cut, and it opens a real repo-wide dedupe opportunity around streamed line parsing.