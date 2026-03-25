# Questions for Plan 4 (Providers)

1. **SDK vs raw fetch for Anthropic**: Previous used @anthropic-ai/sdk. Keep that, or switch
   to raw fetch like OpenAI for consistency and smaller deps?

2. **Prompt caching**: Anthropic supports cache_control on messages. Which messages should
   get cached? System prompt always. What about conversation history?

3. **OpenAI reasoning models (o1, o3)**: These don't support system prompts or streaming
   in the same way. How much special-casing do we need? Previous had some, want to know
   if we should simplify or keep.
