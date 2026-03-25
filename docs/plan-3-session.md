# Plan 3/7: Session

## Overview
Session persistence: history writing, replay workers, API message conversion, attachments.
Budget: ~500 lines added. Target after: ~4,935.

## Subplans

### 3a. History write (~200 lines)

**Expand:** `src/server/sessions.ts` from 77 → ~200 lines

Currently sessions.ts only has read. Add write operations:
- `createSession(id: string, meta: SessionMeta): void` — create session dir + session.ason
- `appendHistory(sessionId: string, entry: HistoryEntry): void` — append to history.asonl
- `updateMeta(sessionId: string, updates: Partial<SessionMeta>): void` — update session.ason
- `forkSession(sourceId: string, newId: string, atIndex?: number): void` — fork history
- `deleteSession(sessionId: string): void` — remove session dir
- `saveSessionList(ids: string[]): void` — write to state/ipc/state.ason

Reference: `prev/src/session/history.ts` (286 lines, read+write combined).

**Blob storage (~50 lines):**

**File:** `src/session/blob.ts`

Port from `prev/src/session/blob.ts` (69 lines).

Blobs store large tool outputs separately from history:
- `writeBlob(sessionId: string, blobId: string, content: string): void`
- `readBlob(sessionId: string, blobId: string): string | null`
- `makeBlobId(): string` — generate unique ID
- Storage: `state/sessions/{id}/blobs/{blobId}.txt`

### 3b. Replay workers (~120 lines)

**File:** `src/session/replay.ts`

Port from `prev/src/session/replay.ts` (276 lines) + `prev/src/session/replay-worker.ts` (43 lines).
Simplify — don't need separate worker file.

Background session replay: rebuild session state from history on startup.
- Walk history entries and rebuild conversation state
- Track token counts per session
- Handle interrupted sessions (incomplete tool calls)
- Run in background after first paint

### 3c. API messages (~100 lines)

**File:** `src/session/api-messages.ts`

Port from `prev/src/session/api-messages.ts` (202 lines).

Convert history blocks → provider API message format:
- Anthropic: content blocks with type: "text", "tool_use", "tool_result", "image"
- OpenAI: messages with role, content, tool_calls, tool_call_id
- Shared: handle image attachments, truncation of large tool results

Key function:
- `toAnthropicMessages(history: HistoryEntry[]): AnthropicMessage[]`
- `toOpenAIMessages(history: HistoryEntry[]): OpenAIMessage[]`

### 3d. Attachments + pruning (~80 lines)

**Attachments (~50 lines):**

**File:** `src/session/attachments.ts`

Port from `prev/src/session/attachments.ts` (76 lines).

- `processAttachment(file: string): Attachment` — read file, detect type, base64 encode images
- `Attachment = { type: 'image' | 'file', mimeType: string, data: string, name: string }`
- Support: png, jpg, gif, webp (images), txt, md, json, etc. (text files)

**Pruning (~30 lines) in sessions.ts:**

Port from `prev/src/session/prune.ts` (131 lines), simplified:
- `pruneSessions(maxAge: number, maxCount: number): void`
- Delete sessions older than maxAge days
- Keep at most maxCount sessions
- Run on startup

## Dependencies
- 3a depends on nothing new (extends existing sessions.ts)
- 3b depends on 3a (needs history read/write)
- 3c depends on protocol types from plan 2
- 3d is independent

## Testing
- `bun test` after each subplan
- `bun cloc` to verify budget
