# LOC reduction plan for `src/providers/openai.ts`

## Snapshot

- Current `bun cloc` LOC for `src/providers/openai.ts`: **659 LOC**
- Current repo total from the same run: **13,500 LOC**
- Target: get this file to **under 500 LOC** while keeping total repo `bun cloc` **flat or down**
- Files/tests reviewed before planning:
- `src/providers/openai.ts`
- `src/providers/openai.test.ts`
- `src/providers/provider.ts`
- `src/providers/shared.ts`
- `src/providers/anthropic.ts`
- `src/openai-usage.ts`
- `src/auth.ts`
- `src/models.ts`
- `src/protocol.ts`

## Review verdict

- The plan is grounded in current code: the dead wrapper/state, duplicated JWT decoding, duplicated conversion helpers, duplicated rotation strings, duplicated compat registry data, and duplicated SSE boilerplate are all present in the files reviewed.
- The main correction is sequencing: the first draft bundled too many new shared helpers too early. That risks turning a LOC-cut pass into helper/glue churn.
- Tightened rule for execution: do cheap deletions and in-file dedupe first, then add only shared helpers that delete code in at least two files immediately. Readability-only extraction and pure file splits stay last.
- Do **not** count a compat-code split as success unless `bun cloc` for the repo is still flat or down.

## What this file currently mixes together

`src/providers/openai.ts` is doing too many jobs at once:

- Native OpenAI transport selection (`api.openai.com` vs ChatGPT Codex backend)
- OpenAI OAuth token introspection (JWT parsing, scope detection, account id extraction)
- Multi-account rotation UI strings and cooldown error wording
- OpenAI Responses API request-body construction
- OpenAI-compatible Chat Completions request-body construction
- Responses API message replay conversion
- Compat message conversion
- Responses SSE parsing
- Chat Completions SSE parsing
- Native OpenAI fetch / error / usage / retry flow
- Compat-provider fetch / error / usage / retry flow
- Compat provider registry data (`COMPAT_ENDPOINTS`) and factory export
- Test-only/public helper surface via the exported `openai` object

That is the real reason it is large: it is both a provider implementation and a mini compatibility framework.

## Biggest line sinks

These are the main contributors, roughly by section size:

- Message conversion for two wire formats: large
- Two separate SSE readers/parsers: very large
- Two separate generate flows with similar fetch/error/usage structure: large
- OpenAI-only auth/account helpers plus duplicated rotation formatting: medium
- Export/factory/registry surface for compat providers: small individually, but avoidable drift and clutter

## Reduction ideas by type

## 1) Delete dead code and dead ownership first

### 1.1 Delete the `getCredential()` wrapper

Today `openai.ts` wraps `auth.getCredential()` in a local 3-line helper used only here.

- Why plausible: it adds no behavior
- Est. impact on `openai.ts`: **-3 to -4 LOC**
- Est. repo impact: **same**
- Risk: none
- Tests to watch: `src/providers/openai.test.ts`

### 1.2 Delete dead `message` tracking in `parseResponsesEvent()`

`response.output_item.added` stores `{ type: 'message' }`, but `response.output_item.done` only cares about `reasoning` and `function_call`.

- Why plausible: this state is written but never used
- Est. impact on `openai.ts`: **-4 to -8 LOC**
- Est. repo impact: **same**
- Risk: very low
- Tests to watch: `src/providers/openai.test.ts`

### 1.3 Trim the exported `openai` namespace to what runtime or tests actually use

From the grep review, runtime imports `openaiProvider` and `createCompatProvider` directly, and tests only use `openai.convertResponsesMessages`. The namespace currently re-exports several helpers that nothing calls.

Candidates to drop from the namespace if they stay unreferenced:

- `convertResponsesTools`
- `convertCompatMessages`
- `convertCompatTools`
- `resolveOpenAIApiUrl`
- `openaiUsesCodexBackend`
- `extractOpenAIAccountId`
- `COMPAT_ENDPOINTS`

- Why plausible: this is dead public surface, not dead runtime behavior
- Est. impact on `openai.ts`: **-4 to -10 LOC**
- Est. repo impact: **same**
- Risk: low, but re-grep before cutting in case another tab added usage
- Tests to watch: `src/providers/openai.test.ts`, any future eval/hot-patch expectations

### 1.4 Keep the module namespace object; only trim it

Right now this file exports named symbols and also an `openai` object. The repo convention prefers a mutable namespace export, and tests already use `openai.convertResponsesMessages`.

- Why this matters: deleting the namespace object saves a few lines but fights the module convention and creates churn outside the real LOC sinks
- Est. impact on `openai.ts`: not worth chasing in the first pass
- Risk: medium relative to project conventions
- Recommendation: **keep the namespace object**, just remove unused members from it

## 2) Simplify local logic without adding new files

### 2.1 Replace the three JWT helpers with one token-inspection helper

Current code splits this across:

- `decodeJwtPayload()`
- `hasOpenAIScope()`
- `extractOpenAIAccountId()`

A single helper like `inspectOpenAIToken(token)` can return:

- `payload`
- `scopes`
- `accountId`
- `hasResponsesScope`

This removes repeated payload decoding and shrinks the helper cluster.

- Why plausible: same token is decoded for related facts
- Est. impact on `openai.ts`: **-10 to -18 LOC**
- Est. repo impact: **same**
- Risk: low
- Tests to watch: routing tests in `src/providers/openai.test.ts`

### 2.2 Collapse repeated “assistant output text” object literals in Responses conversion

`convertResponsesMessages()` repeats this shape several times:

- `{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }`

A helper like `assistantOutputText(text)` or `pushAssistantOutputText(out, text)` removes a lot of repetition.

- Why plausible: repeated identical object literal
- Est. impact on `openai.ts`: **-10 to -16 LOC**
- Est. repo impact: **same**
- Risk: low
- Tests to watch: reasoning replay tests in `src/providers/openai.test.ts`

### 2.3 Add tiny helpers for repeated block conversions in both message converters

Repeated patterns exist in both `convertResponsesMessages()` and `convertCompatMessages()`:

- stringify tool result content
- map text blocks
- map base64 image blocks to data URLs
- split `tool_result` blocks from the rest

Concrete helpers that should pay for themselves:

- `splitUserBlocks(blocks)`
- `stringifyToolContent(content)`
- `imageBlockToDataUrl(block)`

- Why plausible: dual-format conversion currently duplicates the same preprocessing
- Est. impact on `openai.ts`: **-20 to -35 LOC**
- Est. repo impact: **same**
- Risk: low to medium if helper boundaries get too clever
- Tests to watch: all of `src/providers/openai.test.ts`

### 2.4 Merge `convertResponsesTools()` and `convertCompatTools()` around one shared mapper

Both functions do the same schema extraction and differ only in final nesting.

Examples:

- base shape helper returning `{ name, description, parameters }`
- wrapper for Responses: `{ type: 'function', ...base }`
- wrapper for compat: `{ type: 'function', function: base }`

- Why plausible: near-duplicate logic today
- Est. impact on `openai.ts`: **-6 to -12 LOC**
- Est. repo impact: **same**
- Risk: low
- Tests to watch: compat body assertions in `src/providers/openai.test.ts`

### 2.5 Factor the common “record usage on done” stream loop

Both generate paths do:

- iterate parsed stream
- if event is `done` and usage exists and credential is token, record usage
- yield event

That can be one small local helper or generator wrapper.

- Why plausible: exact repeated control flow
- Est. impact on `openai.ts`: **-6 to -10 LOC**
- Est. repo impact: **same**
- Risk: low
- Tests to watch: `src/providers/openai.test.ts`, `src/openai-usage.test.ts`, `src/openai-usage-init.test.ts`

### 2.6 Factor the common “yield error, then done, then return” pattern

Both generate paths repeat several blocks that emit an error event and then a final done event.

A tiny helper generator like `yieldErrorAndDone(partialEvent)` would remove repetition without hiding much.

- Why plausible: repeated 3 times in this file
- Est. impact on `openai.ts`: **-8 to -14 LOC**
- Est. repo impact: **same**
- Risk: low
- Tests to watch: error-path tests in `src/providers/openai.test.ts`

## 3) Dedupe with existing helpers or neighboring modules

These only belong in the first pass if they are immediately net-negative for repo LOC. Prefer the changes that delete obvious duplication in two files over “nice shared abstractions.”

### 3.1 Share rotation/account label formatting with `src/providers/anthropic.ts`

`openai.ts` and `anthropic.ts` both carry almost the same trio:

- `formatAccountLabel()`
- `formatRotationActivity()`
- `formatRotationMessage()`

The only real variable is provider display name (`OpenAI` / `Anthropic`).

Best home:

- `src/providers/shared.ts`, or
- `src/auth.ts` if we decide account rotation wording belongs with auth/cooldown behavior

- Why plausible: this is explicit duplication across providers
- Est. impact on `openai.ts`: **-12 to -18 LOC**
- Est. repo impact: **-15 to -25 LOC net**
- Risk: low
- Tests to watch: `src/providers/openai.test.ts`, `src/providers/anthropic.test.ts`
- Bonus: reduces another large provider file too

### 3.2 Move compat endpoint registry to one canonical place and derive the loader’s compat set from it

Today there are two separate pieces of compat-provider knowledge:

- `openai.ts` has `COMPAT_ENDPOINTS`
- `provider.ts` has `COMPAT_PROVIDERS = new Set(['openrouter', 'google', 'grok'])`

This duplication is small but unnecessary. One canonical map can drive both places.

- Why plausible: prevents key drift and deletes duplicated provider-name lists
- Est. impact on `openai.ts`: **-4 to -6 LOC**
- Est. repo impact: **-5 to -8 LOC net**
- Risk: low
- Tests to watch: provider loading plus compat endpoint test in `src/providers/openai.test.ts`
- Bonus: slightly shrinks `src/providers/provider.ts`

### 3.3 Share “foreign thinking to plain text” helper with `src/providers/anthropic.ts`

`formatForeignThinkingForOpenAI()` and Anthropic’s `formatForeignThinking()` are effectively the same helper with minor typing differences.

- Why plausible: direct duplication
- Est. impact on `openai.ts`: **-4 to -7 LOC**
- Est. repo impact: **small net down**
- Risk: low
- Recommendation: **optional after the bigger wins**; this is real, but too small to drive the first pass by itself

### 3.4 Share tool-JSON parse error formatting with `src/providers/anthropic.ts`

OpenAI Responses, OpenAI compat, and Anthropic all build the same kind of parse-error payload when streamed tool JSON is invalid.

A shared helper like `providerShared.parseToolJson(id, name, json, fallbackInput = {})` would remove repeated try/catch blocks.

- Why plausible: repeated error wording and fallback shape
- Est. impact on `openai.ts`: **-10 to -16 LOC**
- Est. repo impact: **-15 to -25 LOC net**
- Risk: low in code shape, but current tests barely cover these error paths
- Tests to add/watch: malformed tool JSON in Responses, compat Chat Completions, and Anthropic streams
- Recommendation: **good second-wave change**, not before the parser/stream tests exist

### 3.5 Add a shared SSE JSON-event iterator in `src/providers/shared.ts`

This is probably the single best reduction lever.

All three parsers currently repeat the same mechanics:

- `body.getReader()`
- `TextDecoder`
- buffer accumulation
- newline splitting
- `data: ` filtering
- `JSON.parse()` with ignore-on-bad-JSON behavior
- timeout-wrapped `reader.read()` via `providerShared.readWithTimeout()`

A shared async iterator like one of these would pay off immediately:

- `iterateSseDataLines(body)`
- `iterateJsonSseEvents(body)`
- `iterateSse(body, { allowDoneSentinel: true })`

Then each provider-specific parser only handles semantic event mapping.

- Why plausible: clear structural duplication across `openai.ts` twice and `anthropic.ts` once
- Est. impact on `openai.ts`: **-35 to -55 LOC**
- Est. repo impact: **-15 to -35 LOC net** depending on helper size
- Risk: medium, because line trimming rules differ slightly today:
- Responses parser uses `trimEnd()`
- Chat parser uses `trim()`
- compat streams may send `[DONE]`
- parsers intentionally ignore malformed JSON lines
- Tests to watch:
- `src/providers/openai.test.ts`
- `src/providers/anthropic.test.ts`
- any higher-level agent-loop tests that consume provider streams
- Bonus: also reduces `src/providers/anthropic.ts`

## 4) Simplify the generate flows

### 4.1 Pull shared HTTP error-to-event shaping into one local helper

Both generate paths have similar `!res.ok` blocks:

- read/truncate response body
- compute retry delay
- shape a provider error event
- yield final done

Native OpenAI has special 429 rotation logic, so it cannot be fully generic, but most of the scaffolding still can.

A practical split would be:

- generic `readErrorBody(res)`
- generic `baseHttpErrorEvent(providerName, endpoint, res, text)`
- native OpenAI layer adds 429 rotation/cooldown details on top

- Why plausible: keeps native special behavior while deleting repeated boilerplate
- Est. impact on `openai.ts`: **-10 to -20 LOC**
- Est. repo impact: **same now; more if Anthropic adopts it too**
- Risk: low to medium
- Tests to watch: all OpenAI error-path tests, Anthropic tests if generalized later

### 4.2 Pull request-body assembly into named builders

The two generate functions are hard to scan because request assembly and transport logic are interleaved.

Builders like these can shorten the generators without increasing repo LOC much if they replace current inline branching cleanly:

- `buildCompatBody(req)`
- `buildOpenAIHeaders(credential, entry)`
- `buildOpenAIBody(req, credential)`

This is only worth doing if the builders remove repeated conditionals and object-literal branching, not if they merely move code around.

- Why plausible: current body/header construction is a long inlined branch cluster
- Est. impact on `openai.ts`: **-10 to -18 LOC** if done carefully
- Est. repo impact: **flat to slight down**
- Risk: medium if builder extraction adds glue instead of deleting lines
- Tests to watch: all of `src/providers/openai.test.ts`

### 4.3 Factor the “missing credential” path

Compat and native both do the same pattern:

- `ensureFresh(provider)`
- `getCredential(provider)`
- if missing, yield an error and done

Native OpenAI has a slightly different message because of all-on-cooldown handling, but the shape is close enough that a helper can still delete some branching.

- Why plausible: repeated setup flow
- Est. impact on `openai.ts`: **-5 to -10 LOC**
- Est. repo impact: **same**
- Risk: low
- Tests to watch: no-credential paths in `src/providers/openai.test.ts` if added later

## 5) Higher-risk simplifications that may remove surprising amounts of code

These need verification against the real APIs. They are plausible, but not first-pass safe.

### 5.1 Verify the minimal accepted OpenAI Responses replay shape

If the API accepts a smaller replay message shape, repeated fields may be removable:

- `status: 'completed'`
- `annotations: []`
- possibly other boilerplate around assistant replay messages

If those fields are optional, the conversion code gets noticeably smaller.

- Why plausible: many APIs accept omitted defaults
- Est. impact on `openai.ts`: **-8 to -20 LOC**
- Est. repo impact: **same**
- Risk: medium to high because replay correctness matters
- Tests to watch:
- `src/providers/openai.test.ts`
- live/manual verification against actual OpenAI Responses and Codex backends
- `src/session/api-messages.test.ts` for replay-related fallout

### 5.2 Verify whether compat user text can always stay as content parts

`convertCompatMessages()` has special cases for:

- plain string user content
- a single text part becoming a string instead of an array
- multimodal arrays

If all supported compat endpoints tolerate the array form for text-only user messages, some branching can go away.

- Why plausible: modern Chat Completions APIs often accept content arrays
- Est. impact on `openai.ts`: **-8 to -15 LOC**
- Est. repo impact: **same**
- Risk: high because compat endpoints are exactly where standards drift
- Tests to watch: compat endpoint tests in `src/providers/openai.test.ts`; manual checks for OpenRouter/Google/Grok/Ollama-style endpoints
- Recommendation: optional, not first pass

### 5.3 Verify whether the Responses and compat tool mappers can use the exact same normalized tool schema

If downstream APIs accept the same minimal schema extraction path, the tool converters and some request assembly can shrink further.

- Why plausible: only wrapper nesting differs today
- Est. impact on `openai.ts`: **small, -3 to -8 LOC beyond 2.4**
- Est. repo impact: **same**
- Risk: low to medium

## 6) Extraction opportunities that help file size but only make sense if repo total stays flat/down

These are real options, but they should come after net-negative simplifications.

### 6.1 Move compat-provider implementation out of `openai.ts`

This would carve out:

- `COMPAT_ENDPOINTS`
- `convertCompatMessages()`
- `convertCompatTools()`
- `parseChatCompletionsStream()`
- `generateCompat()`
- `createCompatProvider()`

Potential destination:

- `src/providers/openai-compat.ts`

This would almost certainly get `openai.ts` under 500 by itself.

But by itself it is mostly a file split, not a repo LOC reduction.

- Why plausible: compat code is a separate responsibility from native OpenAI
- Est. impact on `openai.ts`: **-120 to -180 LOC**
- Est. repo impact: **flat to +10/+20 LOC** unless combined with real dedupe/deletion
- Risk: low technically, but fails the “flat-or-down total repo cloc” goal if done alone
- Recommendation: **only after** the shared-helper reductions above, or if the file-size target is mandatory and the repo-total target is already satisfied elsewhere

### 6.2 Move Responses conversion and parser logic into focused modules

Potential slices:

- `openai-responses-convert.ts`
- `openai-responses-stream.ts`

Again: useful for readability, but only a good LOC move if paired with dedupe or true deletion.

- Est. impact on `openai.ts`: **large file-local drop**
- Est. repo impact: **likely flat or slightly up** without additional deletions
- Recommendation: not the first pass

## Risks and test areas to watch

## Primary tests

- `src/providers/openai.test.ts`
- `src/providers/anthropic.test.ts` if shared helpers move
- `src/openai-usage.test.ts`
- `src/openai-usage-init.test.ts`
- `src/session/api-messages.test.ts` for replay / message-shape regressions

## Coverage gaps to close before the bigger refactors

The current tests cover routing, simple happy-path streaming, rotation wording, and reasoning replay. They do **not** convincingly pin down the refactors with the biggest LOC payoff.

Add or confirm tests for:

- malformed JSON lines in SSE streams being ignored without aborting the stream
- Chat Completions `[DONE]` handling staying intact
- tool-call JSON parse failures in both Responses and compat parsers
- `response.failed` / `error` / refusal-delta handling in the Responses parser
- compat message conversion for multimodal user content plus tool results

## Main behavioral risks

- Responses replay shape changes breaking Codex backend acceptance
- Compat text/image content normalization breaking one of the non-OpenAI endpoints
- Shared SSE iterator accidentally changing whitespace trimming or `[DONE]` handling
- Shared tool JSON parse helper altering fallback `parseError` wording that tests or retry flows rely on
- Rotation helper extraction changing user-visible 429 wording
- Export-surface trimming breaking tests or eval hot-patches in other tabs

## Recommended execution sequence

This sequence is aimed at getting `src/providers/openai.ts` below 500 LOC with total repo cloc flat or down.

### Step 1: cash the obvious deletions and local dedupe first

Do the in-file cuts that are clearly real and do not need new modules:

- delete `getCredential()` wrapper
- delete dead `message` tracking in `parseResponsesEvent()`
- trim unused fields from the exported `openai` namespace
- merge JWT helpers into one token-inspection helper
- add the tiny local conversion helpers that remove repeated user/tool/image preprocessing
- merge the two tool converters around one normalized schema mapper
- factor assistant replay message construction

Expected effect:

- `openai.ts`: roughly **659 -> 560 to 590 LOC**
- Repo total: down

### Step 2: take the two safest cross-file deletions

Only after Step 1, do the shared changes that obviously delete duplication right away:

- shared rotation/account-label/message helper with `anthropic.ts`
- shared compat-endpoint registry that also replaces `COMPAT_PROVIDERS` in `provider.ts`

Expected effect:

- `openai.ts`: another **-15 to -25 LOC**
- Repo total: down
- Likely range after Step 2: **535 to 575 LOC**

### Step 3: make one big parser reduction, but only with coverage in place

Pick the single biggest real lever:

- shared SSE JSON-event iterator in `src/providers/shared.ts`

Gate this on the stream/parser tests listed above. Do **not** bundle it with unrelated helper extractions in the same pass.

Expected effect:

- `openai.ts`: another **-35 to -55 LOC**
- Repo total: flat to down if Anthropic adopts the same iterator in the same change
- This is the step most likely to push the file under 500

### Step 4: if still above 500, shave the generate flows

Use only the helpers that clearly delete duplicated control flow:

- factor common error/done scaffolding
- factor usage-recording stream wrapper
- only extract request/header builders if the diff is measurably net-negative, not just moved around

Expected effect:

- `openai.ts`: **-10 to -25 LOC**

### Step 5: keep second-wave helpers optional

These are real, but they are not the shortest route to the target:

- shared tool-JSON parse helper with `anthropic.ts`
- shared foreign-thinking formatter with `anthropic.ts`
- higher-risk API-shape simplifications (`status`, `annotations`, compat text-array normalization)

### Step 6: only if the file-size target still misses, split compat code out

This is the escape hatch, not the plan.

- Move compat-only code to a dedicated module
- Only do this after earlier steps have already driven repo total flat/down

## Strongest execution path

If I had to pick the shortest realistic route that still respects repo-wide LOC:

- Step 1 local deletions + converter dedupe
- shared rotation/account formatting helper
- canonical compat registry
- shared SSE iterator, with tests added first
- small generate-flow helper only if still above 500

That path is more believable than the original “add many shared helpers at once” version, and it still looks sufficient to land around **485-505 LOC**. A tiny follow-up shave in the generate path should cover the top end of that range without needing a pure split.

## Opportunities that would also reduce other large files

These are especially attractive because they reduce both file size and total repo size:

- Shared SSE JSON-event iterator reduces `src/providers/openai.ts` and `src/providers/anthropic.ts`
- Shared rotation/account-label/message helper reduces `src/providers/openai.ts` and `src/providers/anthropic.ts`
- Shared tool-JSON parse helper reduces `src/providers/openai.ts` and `src/providers/anthropic.ts`
- Canonical compat endpoint registry reduces `src/providers/openai.ts` and `src/providers/provider.ts`
- If the HTTP error-event helper proves reusable, it can also cut `src/providers/anthropic.ts`

## Bottom line

- **Yes, under 500 still looks reachable in one pass**
- The believable route is: local deletions first, a couple of obvious cross-file dedupes second, then one parser-level reduction
- It still does **not** require a pure file split if the work stays net-negative in repo LOC
- The plan is ready for execution **after** the missing parser/stream coverage is acknowledged and kept in scope during the refactor
- If a split is still needed afterward, move compat-only code out last, not first
