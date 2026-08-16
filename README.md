# HAL 9001

Hal is a terminal-based coding agent with the following goals:

- small TypeScript code base (currently <21k lines), starts with zero dependencies imported
- starts in 100ms on my 6 year old basic Mac laptop (reality: under 200ms, but that's tolerable)
- no auto update nagging; if you want to update, just pull the latest code

Meanwhile, it tries to be reasonably feature complete, have a nice terminal and web UI.

## Contents

- [Installation](#installation)
- [Highlights](#highlights)
- [Architecture](#architecture)
- [Provider support](#provider-support)
- [License](#license)

## Installation

```
git clone https://github.com/anttikissa/hal.git ~/.hal
cd ~/.hal
# Don't trust the code? I wouldn't either. Do something like this:
# claude -p "I just downloaded this project, check that it does what it claims to do and that there are no backdoors"

# Installs prerequisites and adds 'hal' to PATH
./install

cd ~/my/project
hal
```

Use `/login claude` or `/login chatgpt` to start using your Claude or ChatGPT subscription. API keys found in the environment (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, etc.) work too — see [Provider support](#provider-support). A subscription takes precedence over an API key for the same provider.

## Highlights

- Fast and frugal, uses a minimal system prompt by default (see [`SYSTEM.md`](SYSTEM.md)) and has a few basic tools that get the job done
- Support for Claude and ChatGPT subscriptions with account rotation; Gemini, Grok, and OpenRouter work too, as does any OpenAI-compatible endpoint
- Built-in tab support for multiple sessions (ctrl-t to create one, ctrl-w to close, ctrl-n/p and alt-# to switch)
- Forking (ctrl-f forks current session)
- Sessions are aware of each other and can send messages to each other
- `/cd <directory>` changes working directory to another project
- Responds to ctrl-c and ctrl-d immediately and quits
- When you restart it continues from where you left off - just like a browser window with multiple tabs
- Can edit itself (and indeed that's the primary way to extend Hal - there's no plugin system or the like). Start with `hal --self`, or use `/self` to jump to the Hal directory and start hacking
- `/rebase` lets you edit the current conversation context history (similar to `git rebase -i`)
- Press arrow up to amend the previous prompt
- Supports [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md) and whatever the other tools use.
- Terminal UI with amenities you would expect; you can use shift to select text, cut/copy/paste should just work (you need ctrl-v to paste images though), tab completion etc.
- Undo/redo is mapped to cmd-u / shift-cmd-u since most terminals capture cmd-z. The classic emacs shortcut ctrl-/ works too.
- There's a subagent tool, subagents are just separate sessions that show up as tabs. Normally they close automatically, ask Hal to leave them open for inspection if you like. Sessions can send prompts to each other, which is also how subagents pass their results to parent.
- No fancy UI except for quick model selector (ctrl-m) - basically it's just text in, text out
- `/go` command goes to any current or past session / tab and resumes the session if it was closed
- Google search supported through [Serper](https://serper.dev/) (ask Hal to implement other providers if you like)
- New models are found automatically by checking [models.dev](https://models.dev/), and Hal suggests updating your aliases and defaults once new models become available
- Super simple security guardrails: if model tries to read auth tokens or do `rm -rf` or the like, you'll be asked to confirm. These stop accidents, not a determined adversary — any of them can be bypassed trivially, and that's fine: the threat model assumes your model provider isn't malicious.
- You can run `hal` in multiple terminals on the same machine and one of them acts as the server
- There's an `eval` tool that lets Hal run arbitrary JavaScript in the running process, allowing Hal to do brain surgery on itself

What's not implemented:

- Skills are not supported yet, ask Hal to add support if you need them
- Hooks are missing too. The `edit` tool automatically tests for TypeScript errors in .ts files and reports them. Ask Hal to extend itself if you have more complex needs.
- Sandboxing or more complex security infrastructure

## Architecture

`src/main.ts` is the composition root. It decides whether this process is the server or a
client, wires the pieces together, and starts them. Everything else lives in one of five layers:

```
   terminal UI                            browser UI
  (src/client)                        (src/web-client)
        |                                     |
        |  file IPC (state/ipc)               |  HTTP + WebSocket
        v                                     v
  +-----------------------------------------------------+
  |                  server (src/server)                |
  |   runtime · tabs · sessions · tools · providers     |
  +-----------------------------------------------------+
                            |
                            v
                  state/sessions/<id>/
              (durable history, live, blobs)

  src/common  shared contracts + deterministic projections
  src/utils   generic helpers: ason, strings, time, logging
```

- **`src/server`** owns everything stateful: the agent runtime, tabs, session persistence and
  replay, providers, tools, auth/models/usage, and both transports (the file IPC bus and the
  `--web` HTTP/WebSocket server).
- **`src/client`** is the terminal UI. It never imports server internals: the composition root
  injects narrow backend and transport ports, so the client depends on interfaces, not modules.
- **`src/common`** holds Hal-specific but runtime-neutral contracts: the command/event protocol,
  session snapshots, the persisted history shape, and deterministic projections that turn
  server events into renderable blocks. No Bun or Node APIs, so the browser can use it too.
- **`src/web-client`** is the SolidJS browser app, rendering the same snapshots and events.
- **`src/utils`** is generic reusable code with no Hal domain knowledge.

The server produces, persists, and transports semantic events; `common` projects them into
blocks; the terminal and the browser render those blocks independently, which is why both UIs
stay consistent without sharing rendering code. `tests/import-boundaries.test.ts` enforces the
layering: `client`, `server`, and `web-client` can never import each other.

Multiple Hal processes can run at once. The first one becomes the server; the rest are clients
talking to it over the file IPC bus in `state/ipc/`. If the server exits, another process
takes over, which is how you can restart Hal into new code without losing your sessions.

## Provider support

Supported out of the box:

- `anthropic/...` — Claude through Anthropic. Claude subscriptions via `/login claude`, or `ANTHROPIC_API_KEY` for pay-per-token API access.
- `openai/...` — OpenAI models. ChatGPT subscriptions via `/login chatgpt`, which may route through the ChatGPT Codex backend when the token is not scoped for the public API. `OPENAI_API_KEY` uses OpenAI's official Responses API instead.
- `openrouter/...` — OpenRouter through its OpenAI-compatible Chat Completions API. Uses `OPENROUTER_API_KEY`.
- `google/...` — Gemini through the Gemini API's OpenAI compatibility endpoint, using Chat Completions syntax. Uses `GOOGLE_API_KEY`, or `GEMINI_API_KEY` if that is unset.
- `grok/...` — xAI/Grok through its OpenAI-compatible Chat Completions API. Uses `GROK_API_KEY`. This one shares the same compat path as OpenRouter and Gemini, but is the one provider I have not verified recently; let me know if it misbehaves.

If a provider has both a subscription from `/login` and an API key in the environment, the subscription wins; the environment key is only used when no account is configured for that provider. When several accounts are configured for one provider, Hal rotates between them as they hit rate limits.

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

## License

[MIT](LICENSE)
