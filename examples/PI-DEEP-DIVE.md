# Pi (coding-agent) Deep Dive

Detailed analysis of Pi's architecture and notable implementation patterns.

## Architecture Overview

Pi is a monorepo with three key packages:
- `packages/ai/` — AI provider abstraction layer (Anthropic, OpenAI, Google, Bedrock, etc.)
- `packages/agent/` — Generic agent loop (provider-agnostic)
- `packages/coding-agent/` — The actual coding agent (tools, TUI, config, extensions)

The coding-agent package is ~10k lines, with a clean separation between core
logic and UI (interactive mode uses ink/React for TUI).

## Key Architectural Differences from OpenCode

1. **JSONL sessions** instead of SQLite — each session is a `.jsonl` file with
   append-only entries. Different entry types: `message`, `model_change`,
   `thinking_level_change`, `compaction`, `branch_summary`, `custom_message`,
   `label`, `custom`
2. **Extension system** — plugins loaded from `.pi/extensions/` directories.
   Can hook into nearly everything: tool execution, bash spawning, compaction,
   TUI rendering, input transformation, permission checks
3. **No LSP** — no language server integration
4. **No permissions** — relies on extension hooks for confirmation dialogs
5. **Skills system** — follows agentskills.io standard for discoverable
   instruction files

## Session Manager & Entries

Sessions are stored as JSONL files with these entry types:

```
SessionEntry =
  | MessageEntry         (user/assistant/toolResult messages)
  | ModelChangeEntry     (model switch mid-session)
  | ThinkingLevelEntry   (thinking level change)
  | CompactionEntry      (compaction summary + metadata)
  | BranchSummaryEntry   (summary when switching branches)
  | CustomMessageEntry   (injected by extensions)
  | LabelEntry           (named bookmarks in session)
  | CustomEntry          (arbitrary extension data)
```

Each entry has a UUID and parentUUID for tree structure (supports branching).

## Compaction System

Pi's compaction is the most sophisticated of the three projects:

### Preparation Phase (`prepareCompaction`)

1. Find the previous compaction entry (if any)
2. Calculate context token usage from the last assistant message's `usage` field
3. Find cut point: walk backwards from newest, accumulate estimated token counts,
   stop when `keepRecentTokens` (default 20k) is reached
4. **Split turn detection**: if the cut point falls in the middle of a
   user→assistant turn, it splits the turn — summarizing the prefix while
   keeping the suffix
5. Extract file operations from all messages being summarized
6. Return preparation data (no API calls yet)

### Compaction Phase (`compact`)

1. If splitting a turn, generate BOTH summaries in **parallel**:
   - History summary (everything before the split turn)
   - Turn prefix summary (just the first part of the split turn)
2. Merge summaries with a divider
3. Append file operation lists
4. Return result with firstKeptEntryId

### Summarization Prompts

Two prompt variants:
- **Initial**: Creates a fresh structured summary
  (Goal / Constraints / Progress / Decisions / Next Steps / Critical Context)
- **Update**: Takes previous summary + new messages, merges them
  (preserves existing info, updates progress, moves items from in-progress to done)

### Token Estimation

`estimateTokens()` uses chars/4 heuristic per message type:
- User: text content length / 4
- Assistant: text + thinking + tool call arguments / 4
- Tool result: text content / 4
- Images: flat 1200 tokens
- Bash execution: command + output / 4

`estimateContextTokens()` combines:
1. Last assistant message's actual usage (from API)
2. Estimated tokens for messages AFTER the last usage
3. Returns: `{ tokens, usageTokens, trailingTokens, lastUsageIndex }`

**Insight**: Using the last actual API usage + estimating only the trailing
messages is much more accurate than estimating everything from scratch.

## Tool Implementation

### Bash Tool

Notable patterns:
- **Pluggable operations** (`BashOperations` interface) — can swap local shell
  for SSH execution
- **Spawn hook** — extension point to modify command, cwd, or env before execution
- **Command prefix** — prepend commands with e.g. `shopt -s expand_aliases`
- **Rolling buffer** — keeps last `MAX_BYTES * 2` of output in memory for
  tail truncation, streams to temp file if output exceeds threshold
- **Streaming updates** — `onUpdate` callback sends truncated rolling buffer
  to TUI during execution (live preview of command output!)
- **Process tree kill** — kills entire process group, not just the child

### Truncation (shared utilities)

Sophisticated truncation module used by all tools:
- `truncateHead()` — keep first N lines/bytes (for file reads)
- `truncateTail()` — keep last N lines/bytes (for bash output)
- `truncateLine()` — cap individual line length (for grep matches)
- Never returns partial lines (except edge case: last line alone > 50KB)
- Returns rich metadata: `{ truncated, truncatedBy, totalLines, totalBytes,
  outputLines, outputBytes, lastLinePartial, firstLineExceedsLimit }`

### Grep Tool

- Uses ripgrep's `--json` output mode for structured parsing
- Supports context lines (before/after match)
- Case-insensitive, literal search, glob filtering options
- Reads actual files for context lines (with caching)
- 500-char line truncation for grep results
- Match limit with kill signal to ripgrep process
- **Pluggable operations** — can delegate to remote systems

### Find Tool

- Uses `fd` (rust find alternative) when available, falls back to `glob`
- Respects .gitignore at all directory levels
- Result limit with early termination
- **Pluggable operations** — custom glob implementations

### Common Patterns

All tools share:
1. **Abort signal support** — every tool checks `signal.aborted` and registers
   abort listeners
2. **Pluggable operations** — interfaces for swapping local ↔ remote execution
3. **Truncation** — shared truncation utilities with rich metadata
4. **Error handling** — distinguishes user errors from internal errors

## Extension System

Pi's extension system is remarkably powerful:

### Extension Types
- **Tools** — custom tools the agent can use
- **Commands** — slash commands (e.g., `/commit`, `/test`)
- **Flags** — runtime feature flags
- **Hooks** — lifecycle callbacks:
  - `onBashSpawn` — modify bash commands before execution
  - `onCompaction` — custom compaction logic
  - `onPermission` — custom permission checks
  - `onInputTransform` — transform user input before sending
  - `onFooterData` — inject data into TUI footer
  - `onHeaderData` — inject data into TUI header
- **Themes** — custom TUI color schemes
- **Providers** — custom AI providers

### Extension Loading

Extensions are loaded from:
1. Project directory: `.pi/extensions/`
2. Global directory: `~/.pi/agent/extensions/`
3. NPM packages: `npm:package-name`
4. Git repositories: `git:url`
5. Explicit paths in config

Each extension is a TypeScript/JavaScript module that exports a default function
returning an extension definition.

### Example Extensions

Pi ships many example extensions showing the pattern:
- `auto-commit-on-exit.ts` — commits all changes when session ends
- `dirty-repo-guard.ts` — warns if git repo has uncommitted changes
- `git-checkpoint.ts` — creates git checkpoints during session
- `confirm-destructive.ts` — asks confirmation for rm, git push -f, etc.
- `custom-compaction.ts` — replaces default compaction with custom logic
- `handoff.ts` — generates summary for handing off to another agent
- `event-bus.ts` — exposes internal events to extensions
- `inline-bash.ts` — intercepts and modifies bash commands
- `doom-overlay/` — plays DOOM in the terminal (yes, really)

## Skills System

Follows the agentskills.io standard:

### Discovery

Skills are Markdown files with YAML frontmatter:
```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: false
---

# Skill Content

Instructions for the agent...
```

Discovery locations:
1. `~/.pi/agent/skills/` — global skills
2. `.pi/skills/` — project skills
3. Explicit paths in config

Files are discovered as:
- Direct `.md` files in the root skills directory
- `SKILL.md` files in subdirectories (recursive)

### Prompt Integration

Skills are formatted as XML in the system prompt:
```xml
<available_skills>
  <skill>
    <name>my-skill</name>
    <description>What this skill does</description>
    <location>/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

The agent can use `read` to load a skill's content when the task matches.

### Validation

- Name: lowercase a-z, 0-9, hyphens only, max 64 chars, must match parent dir
- Description: required, max 1024 chars
- Respects .gitignore for skipping files

## System Prompt Construction

`buildSystemPrompt()` assembles the prompt from:
1. Tool descriptions (dynamic based on which tools are available)
2. Guidelines (adapt based on available tools)
3. Custom append text
4. Project context files (AGENTS.md, etc.)
5. Skills section (if read tool available)
6. Current date/time
7. Working directory

Guidelines adapt:
- If only bash: "Use bash for file operations"
- If bash + grep/find: "Prefer grep/find/ls over bash (faster, respects .gitignore)"
- If read + edit: "Read before editing"
- If edit: "Use edit for precise changes"
- If write: "Use write only for new files or complete rewrites"

## What's Worth Stealing

### From the compaction system:
1. **Split turn handling** — when the cut point falls mid-turn, summarize the
   prefix separately. We don't handle this case.
2. **Last-usage-based token estimation** — use the actual API usage from the
   last assistant message instead of estimating everything. Much more accurate.
3. **Parallel summary generation** — generate history + turn prefix summaries
   in parallel to save time.

### From the tool system:
1. **Pluggable operations interfaces** — makes testing easy and enables
   remote execution
2. **Rolling buffer for bash** — better than buffering everything, especially
   for commands that produce endless output
3. **Streaming tool output to TUI** — live preview of bash commands
4. **Rich truncation metadata** — enables better UI and model guidance

### From the extension system:
1. **Hook-based architecture** — allows customization without forking
2. **The concept of skills** — discoverable instruction files that the agent
   can load on demand

### From the system prompt:
1. **Adaptive guidelines** — change the prompt based on which tools are available
2. **Date/time injection** — the agent knows when it is

## What's NOT Worth Copying

1. **Extension complexity** — overkill for a personal tool
2. **Multi-provider abstraction** — adds a LOT of code for marginal benefit
   when you're using one provider
3. **NPM/git extension loading** — enterprise feature
4. **DOOM overlay** — tempting but no
