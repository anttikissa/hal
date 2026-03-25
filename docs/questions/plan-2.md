# Questions for Plan 2 (Runtime/Agent)

1. **Provider SDK**: Is `@anthropic-ai/sdk` already in package.json, or should plan 2 add it?
   (Needed for agent loop to actually call providers — but implementation is plan 4.)
   For now: should the agent loop stub out the provider call with a TODO, or block on plan 4?

2. **AGENTS.md loading**: The plan says walk up from cwd collecting AGENTS.md files.
   Should it also load SYSTEM.md? The current AGENTS.md has a `<system>` block that says
   "move this later to SYSTEM.md". Has that happened yet or should we handle both?

3. **Tool call parallelism in agent loop**: The plan says "independent tool calls can run
   concurrently." How do we determine independence? Previous codebase ran all tool_use blocks
   from a single response in parallel. Is that still the desired behavior?

4. **Auth**: `prev/src/runtime/auth.ts` exists. Is auth handling needed in the rewrite, or
   do we just read API keys from env vars?
