# Feature Gap Analysis: HAL vs OpenCode vs Pi

Deep analysis of what the example projects (OpenCode, Pi/coding-agent) implement
that HAL doesn't, focused on **essential features that solve real problems**.

## Executive Summary

HAL is ~1800 lines. OpenCode is ~30k+ lines. Pi is ~15k+ lines. The gap isn't
about code volume — it's about **six essential capabilities** that make the
difference between a toy and a tool you'd actually use for real work.

---

## 🔴 CRITICAL: Must-Have Features We're Missing

### 1. Tool Output Truncation

**The problem**: When bash returns 50,000 lines of output (a large `find`, a
test suite, a build log), the ENTIRE output gets stuffed into the context window.
This wastes tokens, can overflow context, and the model struggles with giant
tool results.

**What they do**:
- Both projects truncate tool output to ~2000 lines / 50KB (whichever comes first)
- Bash output: keep the TAIL (errors and final results are at the end)
- Read/Grep output: keep the HEAD (file contents start at the beginning)
- When truncated, save full output to a temp file and tell the model where it is
- OpenCode: tells the model "Use Grep/Read with offset to explore" or delegates
  to a subagent
- Pi: streams partial output and keeps a rolling buffer

**What we do**: Nothing. `Bun.spawn` output goes straight into the context.

**Impact**: One bad `cat` or `find` command can eat 100k tokens and blow the
session. This is the #1 real-world problem.

**Effort**: Medium. Add truncation to bash output in `tools.ts`. ~100 lines.
Core logic: split into lines, keep last N lines or M bytes, save full output
to `/tmp/hal/tool-output/`, tell the model where the full output is.

### 2. Automatic Retry with Backoff

**The problem**: API rate limits and transient errors (429s, 529 overloaded)
crash the session. The user has to manually restart.

**What they do**:
- OpenCode: Full retry logic with exponential backoff. Reads `retry-after` and
  `retry-after-ms` headers. Max 30s delay without headers. Distinguishes
  retryable errors (rate limit, overloaded) from fatal ones (context overflow,
  auth errors). Shows retry countdown to user.
- Pi: Similar retry with backoff, integrated into the agent loop.

**What we do**: If the API returns an error, we log it and move on. The user
has to retype their request.

**Impact**: Rate limits are COMMON, especially on Opus. Without retry, you lose
work and flow state constantly.

**Effort**: Low-Medium. Wrap the fetch call in `main.ts` with a retry loop.
~60 lines. Parse retry headers, exponential backoff, max 3-5 attempts, show
countdown in TUI.

### 3. Grep/Find as First-Class Tools

**The problem**: The model uses `bash` for everything — `grep`, `find`, `ls`,
`rg`. This means: (a) no truncation on output, (b) no permission control, (c)
the model often gets the flags wrong and wastes a turn.

**What they do**:
- Both have dedicated `grep` tool (wraps ripgrep with proper args, truncation,
  match limiting to 100 results, sorts by modification time)
- Both have `find`/`glob` tool (wraps `fd` or glob, limits to 1000 results)
- Both have `ls`/`list` tool (tree-structured directory listing with ignore
  patterns for node_modules, .git, etc.)
- Results are pre-formatted, truncated, and sorted by relevance

**What we do**: The model runs `grep` via `bash`. Output is untruncated. No
match limits. If there are 10,000 matches, all go into context.

**Impact**: High. Grep/find are the most common tool calls. Dedicated tools
with truncation would save massive amounts of context and reduce errors.

**Effort**: Medium. Add `grep` (shell out to `rg`), `find` (shell out to `fd`
or glob), `ls` (readdir with tree formatting). ~200-300 lines total. The key
is output truncation + match limits.

### 4. File Snapshot & Undo

**The problem**: The model edits a file wrong. There's no way to undo. The user
has to manually `git checkout` or hope the file was committed.

**What they do**:
- OpenCode: Full snapshot system using a SEPARATE git repo (not the project's).
  Takes a snapshot before each tool call. Can revert any change. Shows diffs of
  what changed. Can revert to any point in the conversation.
- Pi: Tracks file state through conversation, supports undo via git.

**What we do**: Nothing. If the model breaks a file, the user has to fix it.

**Impact**: Very high for real work. Fear of the model breaking things is the
#1 reason people don't trust coding agents with destructive operations.

**Effort**: Medium-High. Create a shadow git repo in `~/.hal/data/snapshots/`.
Track file state before edits. Add `/undo` command. ~200 lines for basic
version.

### 5. Permission System

**The problem**: The model can run ANY command. `rm -rf /`, write to any file,
execute arbitrary code. There's no approval step for dangerous operations.

**What they do**:
- OpenCode: Full permission system. Each tool call goes through permission check.
  Bash commands are parsed with tree-sitter to detect what they do. Patterns
  like `rm`, `chmod`, writing outside project dir require approval. User can
  approve "once", "always" (for pattern), or "reject". File edits outside the
  project directory require explicit permission.
- Pi: Uses a confirmation hook system where dangerous operations prompt the user.

**What we do**: Everything is auto-approved. The model can do anything.

**Impact**: For a personal tool, acceptable. For anything serious, this is a
showstopper. Even for personal use, one bad `rm` command ruins your day.

**Effort**: High. Need bash command parsing (tree-sitter or regex), prompt-based
approval in TUI, pattern-based "always allow" memory. ~400+ lines. Could start
simpler: just confirm file writes outside `cwd` and destructive bash commands.

### 6. LSP Integration (Diagnostics After Edit)

**The problem**: The model edits a file and introduces a type error. It doesn't
know until you tell it to run `tsc` or the test suite. Meanwhile it makes more
edits on top of the broken code.

**What they do**:
- OpenCode: Full LSP client integration. After every file edit, touches the file
  with the LSP server. Gets diagnostics (errors/warnings). Feeds them back to
  the model. Supports TypeScript, Python (pyright/ty), Go, Rust, etc. Also
  provides hover, go-to-definition, find-references, etc.
- Pi: Has diagnostics integration for feedback after edits.

**What we do**: Nothing. The model flies blind.

**Impact**: High for codebases with type systems. The model would catch its own
mistakes immediately instead of building on broken code.

**Effort**: Very High. LSP client is complex (JSON-RPC, lifecycle management,
initialization, diagnostics callbacks). ~500+ lines minimum. Could start with
just "run tsc --noEmit after .ts edits" as a simpler approximation.

---

## 🟡 IMPORTANT: Nice-to-Have Features

### 7. Subagent / Task Delegation

OpenCode has a `task` tool that spawns sub-sessions with their own agent. The
primary agent can delegate "explore this codebase" to a sub-agent, keeping its
own context clean. This is powerful for large tasks but not critical for a
personal tool.

### 8. Agent Skills / Context Files

Both projects load `AGENTS.md` / `CLAUDE.md` / skill files from the project
directory and inject them into the system prompt. We already do this (loading
`SYSTEM.md`), but they also:
- Walk up the directory tree finding instruction files
- Load directory-specific instructions when reading files in subdirectories
- Support remote URLs for instructions
- Support skill files with frontmatter metadata

### 9. Structured Tool Output with Metadata

Both projects return tool results as structured objects with `title`, `output`,
`metadata`, and optional `attachments` — not raw strings. The metadata includes
things like truncation info, match counts, preview text for UI display. We just
return strings.

### 10. File Watcher

OpenCode watches the filesystem for changes (using @parcel/watcher). When files
change outside the agent, it can react. Not critical but enables awareness of
external edits.

### 11. Multi-Provider Support

Both projects support OpenAI, Anthropic, Google, Bedrock, Azure, Copilot, etc.
We're hard-coded to Anthropic. Fine for now, but limits flexibility.

### 12. Database-Backed Sessions

OpenCode uses SQLite (via drizzle) for session storage. We use a JSON file.
Their approach supports multiple sessions, search, branching, etc.

---

## Priority Ranking (What to Build First)

| # | Feature | Impact | Effort | ROI |
|---|---------|--------|--------|-----|
| 1 | **Tool output truncation** | 🔴 Critical | Medium | ⭐⭐⭐⭐⭐ | ✅ Done (`b25cc2e`) |
| 2 | **API retry with backoff** | 🔴 Critical | Low | ⭐⭐⭐⭐⭐ | ✅ Done (`777acb7`) |
| 3 | **Grep/Find tools** | 🔴 High | Medium | ⭐⭐⭐⭐ | ✅ Done (`72b629a`) |
| 4 | **File snapshots/undo** | 🟡 High | Medium-High | ⭐⭐⭐ | |
| 5 | **Basic permissions** | 🟡 Medium | Medium | ⭐⭐⭐ | |
| 6 | **LSP / diagnostics** | 🟡 High | Very High | ⭐⭐ | |

Items 1-3 are done. Remaining items are nice-to-haves.

---

## Detailed Comparison Table

| Feature | HAL | OpenCode | Pi |
|---------|-----|----------|-------|
| **Core** | | | |
| Session persistence | ✅ JSON file | ✅ SQLite | ✅ JSONL |
| Context compaction | ✅ Structured | ✅ Structured | ✅ Structured |
| Auto-compaction | ✅ At 90% | ✅ At overflow | ✅ At threshold |
| Streaming | ✅ SSE | ✅ SSE | ✅ SSE |
| **Tools** | | | |
| Bash | ✅ With truncation | ✅ Tree-sitter parsed | ✅ With truncation |
| Read | ✅ Hashline + truncation | ✅ With LSP touch | ✅ With truncation |
| Write | ✅ | ✅ | ✅ |
| Edit | ✅ Hashline | ✅ old/new string | ✅ old/new string |
| Grep | ✅ Dedicated (rg) | ✅ Dedicated (rg) | ✅ Dedicated (rg) |
| Find/Glob | ✅ Dedicated (rg --files) | ✅ Dedicated | ✅ Dedicated (fd) |
| List/ls | ✅ Tree format | ✅ Tree format | ✅ Tree format |
| Web search | ✅ Server tool | ✅ | ❌ |
| Task/subagent | ❌ | ✅ | ❌ |
| **Safety** | | | |
| Output truncation | ✅ 2000 lines/50KB | ✅ 2000 lines/50KB | ✅ 2000 lines/50KB |
| Permissions | ❌ | ✅ Full system | ✅ Hooks |
| File snapshots | ❌ | ✅ Shadow git | ❌ |
| Undo | ❌ | ✅ Per-message | ❌ |
| **Resilience** | | | |
| API retry | ✅ 5x with backoff | ✅ With backoff | ✅ |
| Error recovery | ✅ Retry + session | ✅ | ✅ |
| Crash recovery | ✅ Session restore | ✅ | ✅ |
| **IDE** | | | |
| LSP integration | ❌ | ✅ Full | ❌ |
| Diagnostics | ❌ | ✅ After edit | ✅ |
| **TUI** | | | |
| Split screen | ✅ | ✅ (ink-based) | ✅ (ink-based) |
| Multiline input | ✅ | ✅ | ✅ |
| Clipboard/images | ✅ | ✅ | ✅ |
| Themes | ❌ | ✅ | ✅ |
| **Config** | | | |
| Project instructions | ✅ SYSTEM.md | ✅ AGENTS.md + walk-up | ✅ Skills + frontmatter |
| Multi-provider | ❌ | ✅ | ✅ |
| Custom tools | ❌ | ✅ MCP | ✅ Extensions |

---

## Implementation Notes

### Tool Output Truncation (Priority #1)

```
In tools.ts, wrap bash output:

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

function truncateTail(output: string): { text: string, truncated: boolean } {
  const lines = output.split('\n')
  if (lines.length <= MAX_LINES && Buffer.byteLength(output) <= MAX_BYTES) {
    return { text: output, truncated: false }
  }
  // Keep last MAX_LINES or MAX_BYTES
  // Save full output to /tmp/hal/tool-output/<id>
  // Return: truncated text + "[Full output: /tmp/hal/tool-output/<id>]"
}
```

### API Retry (Priority #2)

```
In main.ts, around the fetch call:

for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  const res = await fetch(...)
  if (res.ok) break
  if (res.status === 429 || res.status === 529) {
    const delay = parseRetryAfter(res.headers) ?? (2000 * 2**attempt)
    tui.log(`[retry] ${res.status}, waiting ${delay}ms...`)
    await sleep(delay)
    continue
  }
  // Non-retryable error
  break
}
```

### Grep Tool (Priority #3)

```
New tool definition:
- name: "grep"
- params: { pattern: string, path?: string, include?: string }
- Shell out to `rg -nH --hidden --no-messages pattern [path]`
- Parse output: file:line:text
- Sort by file modification time (most recent first)
- Limit to 100 matches
- Truncate long lines to 500 chars
```
