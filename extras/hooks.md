# Codex and Claude Code hooks

These optional native Hal plugins run existing command hooks. Nothing is
loaded until you install a private wrapper. They use the same behavior in
terminal and web sessions; no core compatibility framework is involved.

## Enable a reviewed configuration

1. Review the hook configuration **and the programs it executes**. Commands
   run with your user permissions and inherited environment, without a
   sandbox. The digest pins configuration bytes, not scripts or dependencies.
2. Compute its digest without executing it, from the Hal source directory:

   ```sh
   bun -e 'import {load} from "./extras/hook-sources.ts"; console.log(load("claude", {path:"/absolute/project/.claude/settings.json", sha256:""}).hash)'
   ```

3. Create a private `plugins/claude-hooks.ts` wrapper:

   ```ts
   import type { Plugin } from '../src/host/plugins.ts'
   import hooks from '../extras/claude-hooks.ts'

   export default (plugin: Plugin) => hooks(plugin, {
     cwd: '/absolute/project',
     sources: [{
       path: '/absolute/project/.claude/settings.json',
       sha256: 'paste-reviewed-digest-here',
     }],
   })
   ```

   `cwd` explicitly authorizes these commands in that directory and its
   descendants, resolved through symlinks. Other projects are unaffected.
   Paths must be absolute. No configuration, marketplace, or package is
   automatically discovered. List multiple sources to combine them.

For Codex, use `codex-hooks.ts`, flavor `codex` in the digest command, and
an explicitly selected `hooks.json` or `config.toml`. Claude accepts
settings JSON and `hooks/hooks.json`. Unrelated settings are not imported.
A source with `package: true` names a local package directory instead of a
configuration file; use that same flag when computing its digest.

Changed configuration fails closed at the next event. Review changes and
update the digest in your private wrapper. Hal reloads that wrapper;
changes to the reusable extras themselves require a host restart. Disable
with `/plugins disable claude-hooks` (or `codex-hooks`). Unloading cancels
active hook processes and their process groups.

## Supported events

| Event | Hal mapping |
|---|---|
| `SessionStart` | Before the first provider request after this adapter loads for an open session; `startup` without earlier assistant records, otherwise `resume` |
| `UserPromptSubmit` | Latest text-bearing user history record, before its first provider request; includes delivered agent messages |
| `PreToolUse` | Each local Hal tool invocation, after Hal's own approval; denial prevents execution |
| `PostToolUse` | Completed tool result; Codex also receives failures |
| `PostToolUseFailure` | Claude only, when Hal returns an error result |

Session and prompt hooks run at request boundaries, not when a client first
opens a tab or queues a message. A blocked prompt stays in Hal history and
fails the turn before a provider request. Retrying repeats the blocking
check. Restarting/reloading the adapter resets its in-memory lifecycle
tracking; scripts should tolerate repeated startup/prompt notifications.

`BASH` and single-file `READ` are named `Bash` and `Read`. Bash retains
`tool_input.command`; a single Read additionally supplies an absolute
`file_path`, preserving Hal's `path`, `offset`, and `limit`. Other tools
retain native Hal input objects and lowercase names, except the guarded
file-tool aliases below. `tool_response` is Hal's model-facing output
string. Hosted provider tools and later background-job completion do not
generate these events.

Inputs include `session_id`, `cwd`, `hook_event_name`, `permission_mode:
"default"`, and `transcript_path: null`. Hal does not invent a foreign
transcript. `project_root` identifies the explicitly authorized directory.
Tool events add `tool_name`, `tool_input`, and `tool_use_id`; request events
add `model` and `source` or `prompt`.
`permission_mode` is a compatibility label, not an assertion that Hal uses
Claude/Codex's permission engine. Hal's own approval checks still apply.
Batch/URL reads, EDIT batches, and GREP have incompatible foreign schemas.
If any tool-event hook matches their `Read`, `Edit`/`Write`/`apply_patch`, or
`Grep` aliases (including a wildcard), the adapter refuses the tool before
execution with an explicit unsupported-schema error. It does not silently
run a file-policy script with missing fields. Use a native Hal policy
plugin for these tools.

## Commands and decisions

- Command handlers receive JSON on stdin, run concurrently for one event,
  and are awaited. Shell form uses `/bin/sh -c`; Claude's `args` form
  spawns the executable directly with placeholder expansion.
- `timeout` is seconds, default 600 (Claude `UserPromptSubmit`: 30).
  Cancellation and timeout kill the process group, including children.
- Regex matchers follow Codex's rules. Claude's simple names and `|`/`,`
  lists match exactly; other patterns are JavaScript regexes. Empty/`*`
  match all. `UserPromptSubmit` ignores its matcher.
- Exit 2, `decision: "block"`, `permissionDecision: "deny"`, and
  `continue: false` block before a tool/request. After a tool they append
  feedback to its original result and mark it an error; side effects and
  original output remain visible. This deliberately preserves more output
  than Codex's result-replacement behavior.
- `permissionDecision: "allow"` is advisory: it never bypasses Hal approval.
  `additionalContext` is persisted as a notice for the next model request
  and shown to the user. Startup/prompt plain stdout is context too.
  `systemMessage`, stderr, and other plain stdout are shown in session
  output. `suppressOutput` never hides failures.
- Nonzero exits other than 2, malformed JSON, unsupported decisions,
  timeout, and spawn errors fail closed with the command and complete
  captured output. No hook writes directly to Hal's terminal.

## Local package coverage

Codex reads root `plugin.json` with `extensions["com.openai"]`, falling
back to `.codex-plugin/plugin.json` when that extension is absent. Its
explicit `hooks` replaces default `hooks/hooks.json`. Claude reads optional
`.claude-plugin/plugin.json`; explicit `hooks` adds to that default.
Both accept hook paths, arrays, and inline definitions in their documented
shapes. Claude inline values are event maps; Codex inline values wrap them
in `hooks`. Paths must start with `./` and stay inside the package, including
symlink targets. Referencing Claude's default file explicitly loads it once.

Commands receive `CLAUDE_PROJECT_DIR`; package hooks also receive
`PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`. Quote shell path variables, or use
Claude's exec form. Package roots and all hook config files participate in
the digest. Packages are loaded in place; no installation scripts run.

Other components (skills, commands, agents, MCP/LSP servers, workflows,
monitors, settings, dependencies, user configuration, apps) are not loaded;
recognized components produce visible warnings. This is hook-package
support, not a foreign plugin runtime or marketplace installer.

## Unsupported behavior

Other events, including `Stop`, compaction, permission requests, subagent
lifecycle, and session end, are rejected at load. Handler types other than
`command`, async hooks, `if`, `once`, shell overrides, custom failure policy,
and context spilling limits are rejected. Input rewrites, permission
changes, `ask`, MCP-output replacement, terminal sequences, plugin data
variables, and `user_config` substitution are rejected rather than ignored.
`statusMessage` is accepted as descriptive metadata; Hal does not emulate
the foreign spinner. No foreign environment-persistence file is provided.
Hook output is captured in memory in full: keep it concise.

The adapters reread and hash their selected small configuration files at
each boundary so changes cannot silently retain trust. They spawn processes
only for matching handlers and keep lifecycle state weakly tied to open
session metadata; closing sessions does not accumulate a session registry.

Schemas checked against official documentation on 2026-10-24:

- <https://learn.chatgpt.com/docs/hooks.md>
- <https://developers.openai.com/plugins/build/plugins>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/en/plugins-reference>
