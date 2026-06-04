# HAL 9001

Hal is a terminal-based coding agent with the following goals:

- under 10k lines of TypeScript (reality: still under 20k, let's see if that is realistic)
- starts in 100ms on my 6 year old basic Mac laptop (reality: under 200ms, but that's tolerable)
- no dependencies (not strictly true, check `install` script and `package.json` for dev dependencies)
- no auto update nagging; if you want to update, just pull the latest code

Meanwhile, it tries to be reasonably feature complete, have a nice terminal and web UI.

## Highlights

- Fast and frugal, uses a minimal system prompt by default (see SYSTEM.md) and has a few basic tools that get the job done
- Anthropic Claude and OpenAI are supported directly; OpenRouter, Google Gemini, xAI/Grok, and custom OpenAI-compatible providers work through the compat layer
- Tabs (ctrl-t to create one, ctrl-w to close, ctrl-n/p and alt-# to switch)
- Forking (ctrl-f forks current session so you can explore alternative approaches with the current context)
- /cd <directory> changes working directory to another project
- Responds to ctrl-c and ctrl-d immediately and quits
- When you restart it continues from where you left off, just like a browser window with multiple tabs
- Can edit itself (and indeed that's the primary way to extend Hal - there's no plugin system or the like). Start with `hal --self` to edit itself or use the `/self` command which simply changes directory to where Hal lives
- /rebase to edit your context history (similar to `git rebase -i`) if you want to surgically modify context, edit your last prompt, or gaslight the model for fun
- supports AGENTS.md and CLAUDE.md and whatever the other tools use.
- The terminal UI is nice; you can use shift to select text, cut/copy/paste should just work (you need ctrl-v to paste images though), tab completion etc.
- Undo/redo is mapped to cmd-u / shift-cmd-u since most terminals capture cmd-z. The classic emacs shortcut ctrl-/ works too.
- There's a subagent tool, subagents are just separate sessions that show up as tabs. Normally they close automatically, ask Hal to leave then open for inspection if you like. Sessions can send prompts to each other, which is also the way how subagents pass their results to parent.
- No fancy UI except for quick model selector (ctrl-m) - basically it's just text in, text out
- /go command goes to any current or past session / tab and resumes the session if it was closed
- Google search supported through https://serper.dev/ (ask Hal to implement other providers if you like)
- New models are found automatically by checking https://models.dev/ (so you don't need to update Hal when new models become available)
- There are some very basic security guardrails: if the tool call looks suspiciously (destructive action or reading security credentials), Hal will ask you to confirm before running it (see risk.ts for details)
- There's an `eval` tool that lets Hal run arbitrary JavaScript in the running process. Especially useful for introspective work like "Summarize what happened in tabs 4-7 during the last 24 hours". Disable if you don't like dangerous tools.

What's not implemented:
- Skills are not supported yet, ask Hal to add support if you need them
- Hooks are missing too. The `edit` tool automatically tests for TypeScript errors in .ts files and reports them. Ask Hal to extend itself if you have more complex needs.
- Sandboxing or more complex security infrastructure

## Provider support

Supported out of the box:

- `anthropic/...` — Claude through Anthropic. Supports Anthropic OAuth subscriptions via `/login anthropic` and `ANTHROPIC_API_KEY`.
- `openai/...` — OpenAI through the Responses API. Supports ChatGPT/Codex OAuth subscriptions via `/login openai` and `OPENAI_API_KEY`.
- `openrouter/...` — OpenRouter through its OpenAI-compatible Chat Completions API. Uses `OPENROUTER_API_KEY`.
- `google/...` — Gemini through Google's OpenAI-compatible endpoint. Uses `GOOGLE_API_KEY`.
- `grok/...` — xAI/Grok through its OpenAI-compatible endpoint. Uses `GROK_API_KEY`.

Hal also fetches model metadata from [models.dev](https://models.dev/) for context windows and newly released model IDs. A model appearing there does not by itself mean Hal can use it; the provider still needs to be one of the supported prefixes above, or a custom OpenAI-compatible provider configured with `BASE_URL` and `API_KEY`.

Custom OpenAI-compatible providers are also supported. Use an env-friendly provider name in the form `provider/model` and set matching environment variables:

```sh
export KILO_BASE_URL='https://api.kilo.ai/api/gateway'
export KILO_API_KEY='...'
hal
```

Then inside Hal:

```text
/model kilo/stealth/claude-opus-4.7
```

Hal calls `${PROVIDER}_BASE_URL/chat/completions`, so the base URL should be the OpenAI-compatible API root before `/chat/completions`. Custom providers do not get provider-specific compatibility tweaks; if a gateway needs unusual request fields, headers, or a different endpoint shape, Hal may need code changes.

## Installation

```
git clone https://github.com/anttikissa/hal.git ~/.hal
cd ~/.hal
# You could skip this part but I wouldn't recommend it - for this or any other project
claude -p "I just downloaded this project. Do a security review - if I run ./install or the app it installs, does it do anything nasty?"
# Or:
codex -p "I just downloaded this project. Do a security review - if I run ./install or the app it installs, does it do anything nasty?"

# Installs prerequisites and adds 'hal' to PATH
./install

cd ~/my/project
hal
```

Hal picks up API keys from your environment. You can also use `/login` for OpenAI and Anthropic subscription/OAuth credentials.
