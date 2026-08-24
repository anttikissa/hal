# TODO

Random ideas, in no particular order

- readme: Add a screenshot or short terminal recording near the top so readers immediately see the UI.
- readme:Add a command reference table for `/model`, `/login`, `/cd`, `/go`, `/self`, `/rebase`, and `/queue`.
- readme:Add a "Development" section with `bun install`, `./test`, `bun cloc`, and the module/export
  conventions from [`AGENTS.md`](AGENTS.md).
- readme:Add a "Security model" section that explains local file access, confirmation prompts, auth
  storage, `eval`, and the current lack of sandboxing.
- readme: Add a "Configuration" section linking [`config-template.ason`](config-template.ason), local
  `config.ason`, and provider environment variables.
- AGENTS.md change - should send a summary of changes to agent at start of next turn (like /cd,
  model changes, etc)
- colgrep https://github.com/lightonai/next-plaid?tab=readme-ov-file#colgrep
- IPC log truncation / compaction
- Autocomplete should be better: at minimum, if completion is not unique, show/print all available
  completions instead of appearing to do nothing.
- Verify the `grok/` provider against a real `GROK_API_KEY`. Anthropic, OpenAI, OpenRouter, and
  Gemini were probed live and work; Grok uses the same compat path but is untested.
- /what is probably more complicated than it should be; should just probably open a subagent to do it
- Most of config.ason can be ditched. Nobody ever gonna change them. Hardcode more stuff
- The OPUS context usage warning must go. It's not that bad anymore. Instead, think of a generic "this session isn't hitting cache any more" hint in UI
- Fix popup rendering so all underlying frame rows are rendered normally behind the popup; the popup should be a true overlay rather than replacing or omitting the obscured rows.
- Closing a tab/session must abort its active provider and tool processes before deactivation; currently
  `tabs.closeSession()` only archives it, so a process can keep running after close. Durable pending
  questions should remain in history and reappear when the session is resumed.
- Opencode Go support
- /login should support adding API keys too
