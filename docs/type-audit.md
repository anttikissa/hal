# Weak typing audit

Snapshot taken on 2026-04-16 with a simple grep for `any`, `unknown`, `Record<string, any>`, `Array<any>`, `Promise<any>`, and similar patterns.

## Hotspots

- `src/` had roughly **389** loose-typing hits.
- Largest clusters were in:
	- `src/providers/openai.ts`
	- `src/providers/anthropic.ts`
	- `src/runtime/agent-loop.ts`
	- `src/runtime/commands.ts`
	- `src/auth.ts`
	- `src/mcp/client.ts`
	- `src/server/sessions.ts`

## Assessment

Not all weak types are equally bad.

- **Reasonable boundary looseness**
	- Provider stream payloads, ASON parsing, MCP JSON-RPC payloads, and blob contents really do arrive as dynamic data.
	- At those edges, `unknown` plus runtime validation is the right pattern.
	- Raw `any` at those boundaries is the problem, because it lets unchecked assumptions leak inward.

- **High-value fixes**
	- Tool inputs were a good target because they all enter through one registry and have small, well-known schemas.
	- Inbox parsing was another good target because it reads untrusted disk data and immediately acts on it.
	- Small utility helpers were worth tightening because they spread loose types everywhere.

- **Still-risky zones**
	- Provider adapters still carry the most `any` debt. That code handles vendor-specific wire formats, SSE chunks, and several subtly different message schemas.
	- Session/history/blob code also needs stronger intermediate types. Right now many call sites assume blob shapes ad hoc.
	- MCP client typing is still weak around request/response payloads and pending promise resolution.

## Changes made in this branch

- Added structured tool schema types in `src/protocol.ts`.
- Tightened the tool registry in `src/tools/tool.ts`:
	- `execute(input: unknown, ...)`
	- shared `inputObject()` and `errorMessage()` helpers
	- typed schema properties instead of `Record<string, any>`
- Replaced weak tool-input handling in these tools with explicit normalization:
	- `bash`
	- `spawn_agent`
	- `send`
	- `google`
	- `read_url`
	- `read_blob`
	- `eval`
	- `analyze_history`
- Restored and typed `truncateUtf8()` in `src/utils/helpers.ts` and strengthened `debounce()` to use tuple generics instead of `any`.
- Added runtime validation for inbox files in `src/runtime/inbox.ts` instead of casting parsed ASON directly.
- Restored missing `blob` import in `src/session/replay.ts` while touching type-related fallout.

## Recommended next steps

1. **Provider event decoders**
	- Add narrow parser functions for OpenAI/Anthropic SSE events.
	- Keep `unknown` at the fetch boundary, then convert into discriminated internal event types.

2. **Blob payload typing**
	- Introduce explicit blob payload unions for common cases:
		- tool call/result blobs
		- thinking/signature blobs
		- image blobs
	- Stop reading blob fields from `any` objects in random call sites.

3. **History entry helpers**
	- Add small typed accessors for common history entry patterns instead of repeating `entry as any` in runtime/session code.

4. **MCP request/response contracts**
	- Model JSON-RPC envelopes and tool result content blocks explicitly.
	- Replace pending promise `resolve: (v: any) => void` with typed generics.

5. **Auth/config parsing guards**
	- Several auth/config loaders still trust parsed ASON too quickly.
	- Promote the inbox-style guard pattern there too.
