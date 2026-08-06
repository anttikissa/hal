# System prompt files

## Files are concatenated in this order

For a session whose working directory is `~/project/lib`:

```text
${hal_dir}/SYSTEM.md
~/project/AGENTS.md
~/project/lib/AGENTS.md       # or CLAUDE.md when AGENTS.md is absent
```

Hal finds the nearest parent with `.git`, then reads one instruction file in every directory from that Git root to `${cwd}`. `AGENTS.md` takes precedence over `CLAUDE.md`; it never reads both from one directory. Files in sibling or child directories are not included. Outside a Git repository, Hal checks only `${cwd}`.

`${hal_dir}/SYSTEM.md` is always first. If it is missing, Hal uses a minimal fallback prompt. Hal finally adds this explanation for conversation wrappers:

```text
<meta>...</meta>       Hal-generated environment/session information, not a user message
<synthetic>...</synthetic>  Hal-generated assistant text, not model output
```

## Special syntax

Normal Markdown, code fences, HTML, and XML-like tags are plain prompt text. These are the exceptions.

### `<!-- HTML comments -->`

HTML comments are removed from `SYSTEM.md` before the prompt is sent. In `AGENTS.md` and `CLAUDE.md`, they remain visible prompt text.

### `${variable}`

These placeholders are replaced after conditional blocks are selected:

- `${agent}` → `hal`
- `${model}` → `openai/gpt-5.6-terra`
- `${date}` → `2026-08-06, Thursday`
- `${cwd}` → `~/project/lib`
- `${hal_dir}` → `~/.hal`
- `${state_dir}` → `~/.hal/state`
- `${session_dir}` → `~/.hal/state/sessions/00-abc` (empty outside a session)
- `${hal_source}` → `true` when `${cwd}` is in Hal's source tree; otherwise `false`

For example:

```md
You are `${agent}`. Work in `${cwd}` using `${model}`.
```

Unknown placeholders are left as written.

### `::: if name="glob"`

Use a conditional block to include text only for a matching variable:

```md
::: if model="openai/*"
- Use the OpenAI-specific API conventions.
:::

::: if hal_source="true"
- Run `./test` before changing Hal.
:::
```

`*` matches any sequence and `?` one character; the whole value must match. All other punctuation is literal, so `openai/gpt-5.6` matches only that exact identifier.

The opening and closing lines must stand alone and use at least three colons. There is no `else`, `elif`, negation, nesting, escaping, or code-fence awareness. A directive-looking line inside a code sample is still a directive.

Use `/system` to show the compiled prompt. The active prompt files are watched; a change prints a `[system reload]` notice and is used on the next prompt build.
