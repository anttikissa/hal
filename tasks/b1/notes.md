# Notes from implementing b1

- Usage comes in its own chunk *after* `finish_reason`, with empty
  `choices` (only with `stream_options.include_usage`). So `done` must
  wait for `[DONE]`, not fire at `finish_reason`. Some servers leave out
  `[DONE]`: if a finish_reason was seen, the end of the stream counts
  as done.
- The artifact's compat parser turns `length`/`content_filter` into an
  error event. Don't copy that. mapping.md maps them to `done` with
  `max_tokens`/`refusal`, and that is what's implemented.
- Tool results must directly follow the assistant `tool_calls` message.
  A user message with both text and tool results therefore sends the
  `role:'tool'` messages first and the text after them.
- Endpoints without `keyEnv` (local servers) send no Authorization
  header. A missing key throws from `request()`, which becomes an error
  event before any fetch.
