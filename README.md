# Hal

A terminal-based coding agent. Multi-tab TUI, file-backed IPC, ~9k lines of TypeScript.

Built on Bun. No build step, no frameworks.

## Install

Requires [Bun](https://bun.sh) (v1.1+).

```bash
git clone git@github.com:anttikissa/hal.git ~/.hal
cd ~/.hal
./install.sh
```

This symlinks `hal` into `~/.local/bin` and adds it to your PATH in `~/.zshrc` and `~/.bash_profile` if needed.

## Setup

Create `~/.hal/auth.ason` with your API key:

```
{
  anthropic: {
    accessToken: 'sk-ant-...'
  }
}
```

## Usage

```bash
cd ~/my-project
hal                # start working on a project
hal -s             # work on hal itself
```

### Keys

| Key | Action |
|-----|--------|
| Enter | Send message (or resume when paused) |
| Esc | Pause generation |
| Ctrl-F | Fork session |
| Tab 1-9 | Switch tabs |

### Commands

| Command | Action |
|---------|--------|
| `/model <name>` | Switch model |
| `/topic <text>` | Set conversation topic |
| `/queue` | Show queued messages |
| `/drop [N]` | Drop all or specific queued messages |
| `/handoff` | Rotate context, write handoff.md |
| `/reset` | Clear conversation |
| `/fork` | Fork session into new tab |
| `/close` | Close current tab |
| `/clear` | Clear screen |
| `/help` | List commands |

### Steering

Type while the model is generating to queue messages. After 4 queued messages, generation pauses. Double-Enter steers: aborts the current generation and promotes your last message.

## Providers

- **Anthropic** — Claude models (default)
- **OpenAI** — GPT/o-series models
- **Ollama** — local models via `ollama/<model>`

### Ollama

1. Start Ollama locally:

```bash
ollama serve
```

2. Pull a model:

```bash
ollama pull llama3.2
```

3. In HAL, switch to it:

```text
/model ollama/llama3.2
```

You can also use tags like:

```text
/model ollama/qwen2.5-coder:14b
```

## License

MIT
