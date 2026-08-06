# System prompt files

Hal assembles the system prompt from a built-in base prompt and project-local instruction files. This lets a repository provide durable, scoped instructions without putting them in every conversation. The implementation is [`src/runtime/system-prompt.ts`](../src/runtime/system-prompt.ts); `/system` shows the compiled prompt for the current session.

## Sources and order

For a session whose working directory is `cwd`, Hal builds the prompt in this order:

1. `${HAL_DIR}/SYSTEM.md` is the base prompt. `HAL_DIR` is Hal's installation/source directory.
2. Hal finds the nearest ancestor containing `.git`. It reads one instruction file from every directory between that repository root and `cwd`, in root-to-leaf order.
3. At each directory, `AGENTS.md` wins over `CLAUDE.md`. If both exist, only `AGENTS.md` is read; `CLAUDE.md` is a compatibility fallback.
4. Hal appends its fixed transcript-markup explanation.

Later files therefore appear later in the prompt and can add narrower instructions. A repository-level `AGENTS.md` is appropriate for project-wide rules; one in `packages/api/` applies only when that is the session directory or an ancestor of it.

If `cwd` is not in a Git repository, Hal reads only an `AGENTS.md` or `CLAUDE.md` in `cwd`; it does not walk arbitrary parent directories. An unreadable or absent file is skipped. If the base `SYSTEM.md` cannot be read, Hal falls back to a minimal generic system prompt.

`SYSTEM.md` belongs to Hal itself. `AGENTS.md` and `CLAUDE.md` belong to the project being worked on. Project files are not automatically read from directories below `cwd`.

## Comments and ordinary text

The base `SYSTEM.md` supports HTML comments. They are removed before the prompt is sent, so use them for maintenance notes, syntax reminders, and documentation that should not consume model context:

```md
<!-- This note is for people editing SYSTEM.md, not the model. -->
```

That stripping is specific to `SYSTEM.md`. HTML comments in `AGENTS.md` or `CLAUDE.md` are passed through as ordinary prompt text, so do not rely on them being hidden there. Markdown headings, lists, and code fences otherwise remain ordinary prompt content in every source file.

## Conditional directives

A conditional block includes its body only when one prompt variable matches a glob pattern:

```md
::: if model="anthropic/*"
- Prefer the provider's native structured-output feature.
:::
```

The opening and closing lines are control syntax and are not included in the resulting prompt. The opening line must occupy a line by itself in this form:

```text
::: if name="pattern"
```

Use three or more colons, whitespace before `if`, a variable name made of letters, digits, or underscores, and a double-quoted pattern. Close the block with a line containing only three or more colons and optional whitespace.

Patterns use `*` for any sequence and `?` for one character. They match the entire value, not a substring: `openai/*` matches `openai/gpt-5.6-terra`, while `openai` does not. Quote the value even when it has no spaces.

Available variables are:

| Variable | Value |
| --- | --- |
| `model` | Selected model identifier, for example `openai/gpt-5.6-terra`. |
| `date` | Current system date in Hal's display format. |
| `cwd` | The session working directory. |
| `hal_dir` | Hal's installation/source directory. |
| `state_dir` | Hal's state directory. |
| `session_dir` | State directory for this session; empty when no session is supplied. |
| `hal_source` | `true` when `cwd` is Hal's source directory or a descendant (symlinks resolved); otherwise `false`. |

For example, keep a self-modification instruction out of ordinary project sessions:

```md
::: if hal_source="true"
- Run Hal's test suite before changing its implementation.
:::
```

Use a distinct block for each condition. Directives have no `else`, boolean operators, negation, or nesting. An unknown variable is the empty string, so its block normally does not match. Put `::: if ...` and `:::` on their own lines; a directive-looking line inside a code example is still interpreted unless it is inside a stripped `SYSTEM.md` HTML comment.

## Variable substitution

After conditionals are selected, Hal replaces these same variables in ordinary text using `${name}`:

```md
The active project directory is `${cwd}`.
State for this session is `${session_dir}`.
```

Substitution happens after directive processing. This means a value can be both selected by a directive and printed in the prompt. It does not make a directive dynamic within the body: the condition always reads the original variable value.

## Reloading and inspection

Hal watches the base prompt directory and the relevant repository-to-`cwd` directories for prompt-file changes. It emits a `[system reload]` notice when a watched `SYSTEM.md`, `AGENTS.md`, or `CLAUDE.md` changes. The next prompt build uses the new contents. Use `/system` to inspect the fully processed prompt, including selected files, conditionals, and substitutions.

Keep prompt files focused: repository-wide rules near the repository root, scoped rules near the code they govern, and terse comments in `SYSTEM.md` for maintenance-only notes.
