# Plan: docs/features.md

## Goal
Produce a comprehensive features document that could guide a coding agent to rebuild Hal from scratch.

## Approach
1. Read all 527 commits chronologically
2. Cross-reference with actual current source code (not dead ends)
3. Group features by layer/phase
4. Provide the right build order
5. Note which pieces are "ossified" (reusable as-is)

## Key layers (build order)
1. Foundation: ASON, state dirs, config, auth
2. IPC bus (file-backed pub/sub)
3. Session persistence (history, blobs, fork chains)
4. Provider adapters (Anthropic, OpenAI streaming)
5. Runtime (owner election, agent loop, tool execution)
6. Tools (bash, read, write, edit, grep, glob, ls, ask, eval, web_search)
7. CLI/TUI (prompt, rendering, keybindings, tabs)
8. Context management (pruning, compaction, autocompact)
9. System prompt (SYSTEM.md + AGENTS.md chain, preprocessor)
10. Advanced: clipboard/images, attachments, prompt analysis, model switching

Writing to docs/features.md now.
