# Process `SYSTEM.md`, `AGENTS.md`, and `CLAUDE.md`

Hal builds each session's system prompt from a base prompt and instructions scoped to the session's working directory. The implementation is [`src/runtime/system-prompt.ts`](../src/runtime/system-prompt.ts). Run `/system` to inspect the compiled prompt for the current session.

## Files and order

For a session working in `cwd`, Hal reads these sources in order:

1. `${hal_dir}/SYSTEM.md` — Hal's base prompt (normally `~/.hal/SYSTEM.md`). If it cannot be read, Hal uses a minimal fallback prompt.
2. One project instruction file from every directory between the nearest Git root and `cwd`, in root-to-leaf order. In each directory, `AGENTS.md` takes precedence; `CLAUDE.md` is used only when `AGENTS.md` is absent. Hal never reads both from the same directory.
3. Hal's fixed explanation of transcript wrappers such as `<meta>` and `<synthetic>`.

For example, in this tree:

```text
~/work/app/.git
~/work/app/AGENTS.md
~/work/app/packages/api/CLAUDE.md
```

A session in `~/work/app/packages/api` receives `SYSTEM.md`, then the root `AGENTS.md`, then `packages/api/CLAUDE.md`. A session in `~/work/app/packages/web` receives the base prompt and root `AGENTS.md`, but not the API instruction file.

Outside a Git repository, Hal checks only `cwd` for `AGENTS.md` or `CLAUDE.md`; it does not walk arbitrary parent directories. Files below `cwd` are not loaded.

## Comments and ordinary Markdown/XML

`SYSTEM.md` supports maintainer-only HTML comments:

```md
<!-- This explanation is removed before the model sees the prompt. -->
```

Hal strips HTML comments from `SYSTEM.md` before processing directives. HTML comments in `AGENTS.md` and `CLAUDE.md` are **not** stripped: they are ordinary model-visible text and must not be used to hide instructions.

Other Markdown is ordinary prompt text. Hal does not parse headings, code fences, links, XML, or HTML tags. A tag such as `<project>` is literal text. The exceptions are the `${variable}` substitutions and `::: if` blocks described below.

## Variables

After conditional blocks are selected, Hal replaces these placeholders in every prompt source:

| Placeholder | Example value | Meaning |
| --- | --- | --- |
| `${agent}` | `hal` | Hal's agent identity. |
| `${model}` | `openai/gpt-5.6-terra` | The selected model identifier. |
| `${date}` | `2026-08-06, Thursday` | The current system date. |
| `${cwd}` | `~/work/app/packages/api` | The session working directory. |
| `${hal_dir}` | `~/.hal` | Hal's installation/source directory. |
| `${state_dir}` | `~/.hal/state` | Hal's state directory. |
| `${session_dir}` | `~/.hal/state/sessions/00-abc` | State directory for this session; empty when there is no session. |
| `${hal_source}` | `true` | `true` when `cwd` is in Hal's canonical source tree, otherwise `false`. |

For example:

```md
You are `${agent}` working in `${cwd}` with `${model}`.
```

Unknown placeholders stay unchanged. Substitution happens after directive processing, so a directive always checks the original variable value.

## Conditional blocks

Use `::: if name="pattern"` to include a block only when a variable matches:

```md
::: if model="anthropic/*"
- Use the Anthropic-specific API conventions in this repository.
:::
```

Patterns match the whole value. `*` matches any sequence and `?` matches one character; all other punctuation is literal. For example, `openai/gpt-5.6` matches that exact model identifier, while `openai/*` matches any OpenAI model.

A practical source-tree guard:

```md
::: if hal_source="true"
- Run `./test` before changing Hal itself.
:::
```

Directives must be on their own lines and use three or more colons. Values are double-quoted. There is no `else`, `elif`, negation, nesting, escaping, or code-fence awareness: a directive-shaped line in a code sample is still a directive. An unknown variable has the empty value.

## Changes

Hal watches `SYSTEM.md` and the applicable project-instruction directories for active sessions. A change produces a `[system reload]` notice; subsequent prompt builds use the new contents.
