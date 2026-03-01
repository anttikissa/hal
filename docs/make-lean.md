Here's the budget breakdown (9,950 LOC total):

| Subsystem | LOC | % | Notes |
|-----------|----:|--:|-------|
| **TUI** | 3,275 | 33% | `tui.ts` alone is 1,767 — the single biggest file |
| **Runtime** | 2,153 | 22% | Agent loop, command handling, sessions, scheduling |
| **Core/shared** | 2,078 | 21% | Tools (580), main (367), session (316), ASON (299), IPC (183) |
| **Providers** | 1,183 | 12% | OpenAI (417) + OpenAI Completions (359) = 776 for two OpenAI adapters 
|
| **CLI formatting** | 415 | 4% | Commands, themes, format helpers |
| **Web** | 199 | 2% | Web UI + SSE |
| **Utilities** | 647 | 6% | Debug, hashline, token calibration, config, etc. |

Observations:

1. **TUI is a third of the codebase.** `tui.ts` at 1,767 lines is the obvious compression target if we 
ever need space.
2. **Two OpenAI adapters cost 776 lines** — `openai.ts` (Chat API) and `openai-completions.ts` 
(Completions API for Ollama). That's 8% of budget on one provider family.
3. **tools.ts at 580** is surprisingly heavy for tool definitions.
4. **ASON at 299** — custom serialization isn't free.
5. **debug-log + debug-replay = 237** — debugging infra takes 2.4%.

The biggest savings opportunities would be in `tui.ts`, consolidating the two OpenAI adapters, and 
trimming `tools.ts`. Want me to dig into any of these?
model: codex
[model] anthropic/claude-opus-4-6 -> openai/gpt-5.3-codex
[system] reloaded SYSTEM.md, AGENTS.md (model changed)


Then prompt:

 Do deep analysis - especially OpenAI wise - does the provider directory have to be so large? What is 
 the completions API? I thought Ollama is OpenAI compatible and we already had OpenAI support? Would 
 it make sense to have OpenAI the "default" and then have Anthropic adapter for that? Would that 
 reduce LOC? 
  
 I'll add another tab to check for TUI savings - you can leave that be. 


