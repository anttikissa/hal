# Pi extensions and an optional Hal adapter

Research snapshot: 2026-10-24. This is a compatibility assessment, not an
implementation commitment.

## Recommendation

Start, if requested, with an optional `pi-compat` plugin that runs the
**unmodified `pi-simplify@0.2.3` extension**. Its `/simplify` command identifies
changed Git lines and submits a scoped simplification prompt. The published
JavaScript needs only three `pi` methods, `ctx.cwd`, and `ctx.ui.notify`.
No Pi runtime package, custom terminal renderer, provider, session database,
or extra model tool is needed. A reusable command/exec/message slice is useful;
implementing the whole Pi API first is not.

A Bun probe imported the actual published extension and exercised staged
changes, no changes, and explicit files with a Git ref using an in-memory
four-method facade. All three checks passed. This establishes import and
handler feasibility, not an integrated Hal adapter or actual Git execution.

## Evidence and scope

Official sources:

- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Exported API types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)
- [Popularity catalog](https://pi.dev/packages), sorted by monthly downloads.

Official repository measured at 117,578 GitHub stars. Its main revision was
`d0aa218cb16c333c008f6aa3dcd670ac8b68383c`; package.json reported version 1.4.0,
Node >=22.19.0. These are current-source observations, not an assertion that
all installed Pi versions expose this API. Old `badlogic/pi-mono` links and
`@mariozechner/*` package names still occur in ecosystem material. Current
official packages use `@earendil-works/*` and `typebox`.

Important correction to older comparisons: current Pi has built-in MCP,
`registerMcpServer`, deferred tools, and codemode. “Pi has no MCP” is stale.

The following is a **popular applicable sample**, not a global top-15 claim:
14 high-download extension packages from the catalog's first page, plus the
smaller command-only candidate chosen for minimal adaptation. Generic skill
packs and cross-agent products were excluded. The catalog showed 5,341 total
packages, including skills, themes, prompts and bundles, not 5,341 extensions.

Downloads are exact npm API counts for **2026-09-23 through 2026-10-22**, queried
2026-10-24 via `https://api.npmjs.org/downloads/point/last-month/<package>`.
They count package fetches, not users or Pi-only usage. The catalog's rounded
cached values sometimes differed; the table uses the direct API. Stars are
live GitHub repository counts queried the same day. A monorepo's stars are
not an individual extension's stars. Versions are registry `latest` at query
time. Package manifests and published JS/TS were inspected without installing
or executing their dependencies.

## Fifteen candidates

Effort labels describe relative compatibility scope, not measured build time.
“High” generally requires session, model, or terminal semantics beyond tools
and commands. Every source link below is the package's declared repository.

| Package/version and source | Monthly downloads | Repo stars | Unit and useful behavior | Adapter demands |
|---|---:|---:|---|---|
| [pi-mcp-adapter 6.0.0](https://github.com/nicobailon/pi-mcp-adapter) | 1,459,406 | 1,614 | Extension; token-efficient MCP discovery and calls | High: dynamic tools, active sets, lifecycle, commands/UI, MCP registrations; subprocess/HTTP/OAuth and native keyring dependencies |
| [pi-web-access 0.44.0](https://github.com/nicobailon/pi-web-access) | 801,838 | 1,684 | Extension; search, fetch, PDFs and video | Medium/high: tools/results, session events, messages/widgets, provider configuration; parser and network dependencies |
| [pi-subagents 0.81.0](https://github.com/nicobailon/pi-subagents) | 558,314 | 4,007 | Bundle: extension, skills, prompts; delegation and workflows | High: Pi sessions/agent SDK, child runtimes, model selection, message renderers, UI and cancellation |
| [pi-mcp-extension 1.10.2](https://github.com/irahardianto/pi-mcp-extension) | 400,439 | 10 | Extension; MCP clients | Medium/high: tools, active sets, lifecycle, commands, status and project trust; MCP SDK/Zod, transports and OAuth |
| [@juicesharp/rpiv-ask-user-question 2.15.0](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | 231,411 | 919* | Individual package in a monorepo; structured questions | Medium through its RPC dialogs; high for custom terminal parity. Tools, active sets, events, UI and cancellation |
| [@langfuse/pi-observability-plugin 0.1.2](https://github.com/langfuse/pi-observability-plugin) | 182,036 | 21 | Extension; tracing | Medium: lifecycle/message/usage/session translation, exec and status; OpenTelemetry/Langfuse. Explicit opt-in before loading/exporting |
| [@juicesharp/rpiv-todo 2.15.0](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | 151,513 | 919* | Individual package in a monorepo; persistent task panel | Medium/high: tools, commands, shortcuts, appendEntry, branch replay and terminal panel |
| [@plannotator/pi-extension 0.28.30](https://github.com/backnotprop/plannotator/tree/main/apps/pi-extension) | 107,084 | 9,608* | Pi integration within a broader multi-agent product | High: browser review server, tools/commands, events, prompts, session state, model controls and project trust |
| [pi-goal-x 0.34.0](https://github.com/tmonk/pi-goal-x) | 88,857 | 109 | Extension; persistent goals and optional completion auditor | High: continuation/settlement, sessions, messages, tools and custom UI; guard against automatic loops |
| [pi-powerline-footer 0.21.0](https://github.com/nicobailon/pi-powerline-footer) | 82,484 | 460 | Extension; configurable status/footer | High: footer/editor/header components, theme and terminal input; little reusable host-only behavior |
| [pi-lens 4.4.4](https://github.com/apmantza/pi-lens) | 76,758 | 491 | Bundle: extension and skills; LSP, lint, structural feedback | High: tool interception, edit semantics, context/events, diagnostics lifecycle; language servers, native ast-grep and WASMs |
| [pi-claude-bridge 0.9.3](https://github.com/elidickinson/pi-claude-bridge) | 73,859 | 711 | Extension; Claude Agent SDK provider and AskClaude tool | High: provider streaming/messages, Pi model/session helpers, MCP bridge, SDK subprocesses and separate authentication |
| [@langchain/langsmith-pi-extension 0.2.1](https://github.com/langchain-ai/langsmith-pi-extension) | 72,351 | 4 | Extension; tracing | Medium: event/session/usage mapping and status/command; LangSmith/Zod. Upstream tracing defaults off |
| [pi-advisor-flow 0.14.2](https://github.com/philipbrembeck/pi-advisor) | 67,840 | 54 | Extension; second-model review and loop gates | High: model/runtime calls, usage, session reconstruction, tools, event bus and custom UI |
| [pi-simplify 0.2.3](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) | 37,896 | 152* | Individual extension in a monorepo; changed-line simplification | Low: registerCommand, exec, sendUserMessage, cwd and notify; Git only, no runtime dependencies |

`*` Stars belong to the entire monorepo/product. Repeated rpiv counts refer to
one repository and must not be added. An extension package may itself contain
many tools; “individual” here distinguishes the installable package from the
repository or a bundle carrying other resource types.

## Compatibility map

| Pi surface | Contract and Hal mapping |
|---|---|
| Module loading | Default sync/async factory receives ExtensionAPI. Pi uses jiti; Hal can load plain JS/TS with Bun. Resolve only supported runtime imports; type-only imports disappear. Explicitly select/pin packages rather than importing Pi settings or autoloading project packages. |
| Lifecycle | `input`, run/turn/message/tool/provider events, session replacement, compaction, discovery and settlement. Pi turns correspond more closely to Hal rounds, not whole Hal turns. Use awaited `plugin.around` for transformation/gates; Hal before/after observers do not await handler results. |
| Event composition | Pi registration order, unsubscribe, snapshot dispatch, chained transforms, mutation, cancellation and notification differ by event. `agent_end` is not final idle; retries/compaction/queued work can follow. Preserve distinct `agent_before_settle` and `agent_settled` semantics. |
| Tools | TypeBox schemas; execute(callId, args, signal, onUpdate, ctx); content/details, optional structured output, errors, usage and termination. Translate registered tools into Hal commands beneath its existing native `tool`; expose HELP lazily, retain schema validation and cancellation. Do not add provider-native tools or lose trust checks. |
| Dynamic tools/MCP | Active sets, exposure modes, namespaces, nested executeTool, annotations, prepareLoadout and reachesTools are real semantics, not synonyms for registration. Handle incrementally; MCP clients can own transport without recreating every Pi built-in. |
| Commands | registerCommand handler(args, ctx), description and optional argument completion. Hook Hal commands.all and commandList.all; map context per invocation. Reject collisions. No persistent command file is necessary. |
| UI | notify and supported dialogs can map to Hal messages/forms. Pi custom components, footer/editor replacement, shortcuts and terminal-input interception require a separate renderer adapter. Hal forms replay commands after answers rather than holding arbitrary UI promises. RPC-friendly paths are a better starting point than emulating Pi TUI. |
| Session/history | appendEntry, branch-sensitive tool details, getBranch, labels, forks, compaction and session navigation expect Pi's session model. Hal's ASONL history is not Pi's session JSONL. Build deliberate projections and namespaced persistence, not a fake path or in-place conversion. |
| Messages/control | sendUserMessage followUp maps to Hal queued delivery; steer maps only with matching interruption rules. Custom messages need durable model-visible versus UI-only distinctions. Model/thinking changes and compaction need explicit control mappings. |
| Providers | registerProvider/registerVirtualModel plus Pi AI streams, OAuth/model registry and nested usage are a substantial separate adapter. Reusing Hal providers directly is simpler unless a concrete extension needs these APIs. |
| Resources/config | Package manifests can bundle skills, prompts and themes independently. Markdown resources often need no executable compatibility layer. Flags/settings/project trust should be explicit Hal configuration, not hidden environment-driven defaults. |
| Event bus/cleanup | pi.events can use an owner-scoped emitter. One host serves many sessions, unlike common foreground Pi assumptions. Bind context/state per session and dispose handlers, timers, subprocesses and pending work on unload/reload. |

Extensions have the process's OS permissions, not a sandbox. Many import
Node fs/path/child_process, TypeBox, Pi AI/TUI utilities, MCP SDKs, or native
modules. Modern official Pi requires Node >=22.19; individual packages range
from >=18 to >=22.19. Bun can load many, but compatibility must be checked per
dependency. Avoid installing the whole Pi SDK merely to satisfy a type import.
Some packages retain `@sinclair/typebox` peers while current Pi uses `typebox`.
Physical copies of host-provided packages can create duplicate classes and
registries; Pi's own package docs warn against bundling them.

## Exact minimal shim for pi-simplify

Source inspected: published `dist/index.js`, `simplify-command.js`,
`git-diff.js`, and `prompt-builder.js` in version 0.2.3.

1. Load the pinned published entry and call its default factory with the facade.
   Capture `registerCommand('simplify', definition)` in plugin-owned state.
2. Hook `commands.all()` to add a SlashCommand whose run invokes the captured
   handler with its raw argument string. Hook `commandList.all()` for command
   discovery/help in both clients. Include `--staged` and `--ref=` completion;
   do not assume the extension supplies completion itself. Refuse a collision.
3. Supply `ctx.cwd` from the current Hal command context and `ctx.ui.notify`
   through that context's durable `say`, never stdout/stderr.
4. Supply `pi.exec(command, args, {cwd})` using an argv-based child process with
   captured stdout/stderr and `{code, stdout, stderr, killed}`. No shell quoting
   or eval. Preserve exec errors; impose cancellation/timeout policy explicitly.
   This extension invokes only Git diffs, including one hunk query per file.
5. Supply `pi.sendUserMessage(text, {deliverAs:'followUp'})` through
   `prompts.submit(sessionId, text, undefined, 'queue', sender)` with
   extension/command provenance. Check and surface its returned error.
   Resolve session context with AsyncLocalStorage or a fresh facade per session,
   not a global mutable current-session variable: handlers await Git calls.
6. Unloading removes only these hooks/registrations. In-flight callbacks must
   either complete against their captured session or be explicitly canceled;
   never silently reroute to whichever tab is now selected.

Estimated effort: a small command-only prototype in roughly half a day; one
or two developer days for concurrent-session, unload, cancellation, delivery
and both-client checks. These are planning estimates, not measurements. A
broad Pi runtime adapter would be a different, much larger project.

Tradeoffs and concrete limitations:

- This is an editing prompt, not a read-only code review. The command tells the
  model to apply simplifications in changed lines and then run tests.
- Upstream falls back to `HEAD~1` if the chosen diff is empty or fails, including
  `--staged`. It ignores untracked/deleted-only files, splits arguments on
  whitespace, and omits Git failures in favor of fallback/no-change behavior.
  Preserve and disclose these upstream behaviors, or propose fixes upstream;
  do not silently claim the adapter changes them.
- The no-shell argv bridge avoids shell injection, but arbitrary imported
  extensions can bypass it and call OS APIs themselves. Trust is still required.
- No credentials, network, telemetry, custom UI, Pi global config, or model
  providers are needed for this target. Telemetry candidates must remain opt-in
  before module initialization can start collection or export.
- After a day, the minimal slice retains registrations, not duplicated session
  history. With 10× changed files, the extension performs 10× per-file Git
  subprocess calls concurrently; that is the main scaling concern. No CPU
  performance measurements were taken. Most larger candidates bring persistent
  servers, watchers, transcript copies or UI loops requiring separate review.

Before calling a real adapter verified: exercise actual Git output in a
fixture; idle and busy queued delivery; explicit files and refs; no changes;
Git failure; simultaneous sessions with distinct cwd; command collisions;
reload/unload; visible errors; and command/help/completion in terminal and web.
The research probe covered only published-module import and three handler paths.
