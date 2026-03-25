# Plan 5/7: Tools

## Overview
Tool implementations: registry, bash, file tools, eval, send.
Budget: ~450 lines added. Target after: ~5,885.

## Subplans

### 5a. Tool registry + base (~50 lines)

**File:** `src/tools/tool.ts`

Port from `prev/src/tools/tool.ts` (50 lines).

```ts
interface Tool {
	name: string
	description: string
	parameters: Record<string, ParameterDef>
	execute(input: any, context: ToolContext): Promise<ToolResult>
}

interface ToolContext {
	sessionId: string
	cwd: string
	signal: AbortSignal
}

interface ToolResult {
	output: string
	error?: string
	// For blob storage of large outputs
	blobId?: string
}
```

- `registerTool(tool: Tool): void`
- `getTool(name: string): Tool | null`
- `allTools(): Tool[]`
- `toToolDefs(): ToolDef[]` — convert to provider API format (Anthropic tool_use schema)
- `dispatch(name: string, input: any, context: ToolContext): Promise<ToolResult>`

### 5b. Bash (~100 lines)

**File:** `src/tools/bash.ts`

Port from `prev/src/tools/bash.ts` (150 lines).

Shell execution with:
- Configurable timeout (default 120s)
- Output capture (stdout + stderr combined)
- Output size limit (1MB, per AGENTS.md rule)
- Working directory from session context
- PTY support for commands that need it
- Exit code tracking

Uses Bun.spawn or Bun.$ for execution.

Parameters:
- `command: string` (required)
- `timeout?: number` (ms, default 120000)

Truncation: if output > 1MB, keep first 500KB + last 500KB with
"[truncated N bytes]" marker in the middle.

### 5c. Read/Grep/Glob (~120 lines)

**File:** `src/tools/read.ts` (~50 lines)

Port from `prev/src/tools/read.ts` (50 lines).
- Read file contents with optional line range
- Parameters: path, startLine?, endLine?
- Detect binary files, return error
- Line numbers in output
- Size limit: 1MB

**File:** `src/tools/grep.ts` (~40 lines)

Port from `prev/src/tools/grep.ts` (45 lines).
- Search file contents using ripgrep (rg)
- Parameters: pattern, path?, glob?, maxResults?
- Shell out to `rg` with appropriate flags

**File:** `src/tools/glob.ts` (~30 lines)

Port from `prev/src/tools/glob.ts` (36 lines).
- Find files matching glob pattern
- Parameters: pattern, path?
- Use Bun.glob or shell out to find

### 5d. Write/Edit (~80 lines)

**File:** `src/tools/write.ts` (~80 lines)

Merge `prev/src/tools/write.ts` (43 lines) + `prev/src/tools/edit.ts` (122 lines).

Two operations in one file:
- **Write:** create or overwrite file. Parameters: path, content
- **Edit:** surgical string replacement. Parameters: path, oldString, newString
  - Must find exact match of oldString in file
  - Error if no match or multiple matches (ambiguous)
  - Return diff-style output showing change

Both:
- Create parent directories if needed
- Return confirmation with file path and line count

### 5e. Eval (~50 lines)

**File:** `src/tools/eval.ts`

Port from `prev/src/tools/eval.ts` (81 lines), simplify.

Runtime JS eval for hot-patching:
- Execute arbitrary JS/TS in the runtime context
- Has access to all module namespaces (import them)
- Parameters: code (string)
- Returns: stringified result or error
- Timeout: 10s default

This is the power tool — lets the agent inspect and modify its own runtime.

### 5f. Send (~50 lines)

**File:** `src/tools/send.ts`

Port from `prev/src/tools/send.ts` (42 lines).

Send message to another Hal session:
- Parameters: sessionId (or "all"), message
- Write .ason file to target session's inbox directory
- Return confirmation

## Dependencies
- 5a first (registry needed by all tools)
- 5b-5f can be done after 5a, in any order
- All tools register themselves on import

## Testing
- `bun test` after each subplan
- `bun cloc` to verify budget
