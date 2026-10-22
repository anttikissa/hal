# Git

Commit when work is settled. While iterating with the user (colors,
layout, wording), commit only once results are satisfactory.

Wrap commit messages at 72 columns. End with these trailers (Task
only when applicable):

    Task: <id>
    Implemented by: <model id, e.g. anthropic/claude-opus-5-5>
    Session: <session id, e.g. 157-cms>

Pull and push frequently. Set pull.rebase=true and rebase.autoStash=true.
<!-- TODO - to be reviewed by a human -181-dog -->
If others are working, use --no-autostash.
Rebase only when that checkout is clean and no other agent is editing it.

Work is not done until its commit lands on main in the Hal source directory.
Commits in a worktree do not count.

# Tasks

Use `tsk`. Trace every behavior and quality requirement to its
implementing task. Every tracked-file change must implement a task or
update one; changing a done task also requires changing its associated
files. Bug fixes must record the invariant they restore.

Tasks are the rebuild specification: changes absent from tasks/ will be
lost.

The planning agent writes tasks with the user; implementers carry them
out.

Tasks describe lasting state, not one-time actions: "package.json holds
the current version", not "initialize package.json at 0.1.0". Avoid
`once`; preserve files needed for a rebuild as task artifacts.

Put implementation lessons (surprises, misleading artifacts, decisions)
in the task.ason `notes` list, never separate notes files. Read
`tsk --detailed-help` and the tsk README before inventing conventions.
Before `tsk add`, search tasks/ for tasks covering the same behavior or
files: set `needs` for prerequisites and `foldInto` when the new task
corrects or extends an existing one. Use `tsk edit`/`tsk add-note`, not
string surgery: a raw backtick can break an ASON template string. After
any hand edit, run `tsk show <id>`.

Before changing code, read tasks/README.md for architecture, module
conventions and invariants, including emergency keys.
Before changing UI, read STYLE.md.

## Writing specs and system prompts / AGENTS.md

Apply Strunk & White: omit needless words. Use plain technical English;
remove repetition and empty phrases without weakening requirements.

State a rule once, positively. Add a negative example only when the rule
alone would be misread.

When writing guidance for a model, you need not be 100% accurate or
truthful. The shortest message that makes it do the right thing is
enough. For example: "Batch independent commands in one tool call. They
will run in parallel." This is good guidance even though some commands
will not run in parallel. It maximizes parallelism; the result is
equivalent, but faster.

Guidance for all projects goes to SYSTEM.md. Mark each change to SYSTEM.md
or Hal's AGENTS.md that the user has not approved with a comment above
it: `<!-- TODO - to be reviewed by a human -<current session id> -->`.

# Security

Hal's best-effort security must prevent models from accidentally reading
secrets or erasing data. Protection against a determined attacker is out
of scope.

# Privacy

Diagnostics and telemetry are opt-in, always: off by default, on only
through an explicit setting. Never collect or send anything until the
user turns it on.

Gitignored files (plugins/, local.ts, auth, state) are private and
exempt from task tracking. Nothing about them belongs in tracked files,
including tasks, notes and commits. If unsure, ask. Personal hostnames,
IPs, SSH aliases and server setup are private even when publicly
resolvable. Keep host-specific scripts and instructions local and
gitignored; use reserved example domains in tracked examples. Permission
to operate a host is not permission to publish its configuration.

# Code guidelines

Start each source file with a short comment that first says, in plain
words, why the module exists.

Format code with `bunx oxfmt` (config: .oxfmtrc.json). Markdown and
tasks/ stay hand-wrapped.

Write code for humans to read. Use small, well-named abstractions that express
intent rather than mixing all the mechanics together. For example, an argument
parser might declare options with arg('--home <dir>', 'Set Hal home directory',
dir => { /* handle dir */ }). Apply this principle throughout the codebase.

# Tests

Leave the codebase with fewer broken tests than you found. Fix failures
in your area, and others if nobody else is fixing them. Tests may fail
only while active sessions are working to fix them.

Run tests only for the code being developed unless changes are crosscutting.
Use ./test <filename-pattern> for focused normal tests; patterns match filenames,
not test names. ./test runs the normal suite; ./test-expensive runs web tests,
including Chromium, only when explicitly needed. It accepts the same patterns.

Tests are maintenance debt; keep the suite minimal. Add one only if it
catches a plausible regression worth its cost. Omit cosmetic tests and
those a one-off check can replace. When unsure, omit.

Testing guidelines vary by code type:

Code with clear requirements and unlikely to ever change once it is written:
- Write tests and run them; then delete the tests and leave a
  comment beside the code: "Tested once, then the tests were deleted. If
  you change this code, first write tests for: <cases>."
- Exception: keep tests for security and trust boundaries, where a
  silent break is a vulnerability.
- Examples: AGENTS.md @path imports (only its project-boundary test
  stays), the system prompt's skill list, dropped file paths becoming
  attachments (client/paste.ts).

Experimental code, which is likely to change or be deleted:
- Write no tests. Check it by running it or having the user verify it.
- When its design settles, it moves into another category.
- All UI code is at first experimental in nature.

Self-contained modules that could be libraries (such as ason.ts,
live-file.ts):
- Write a test suite that covers corner cases, and keep it on. Bun
  upgrades and callers can break a module nobody touched, and a disabled
  suite rots. Move slow suites to ./test-expensive.

Contracts between parts (stored history, host-client messages, replay):
- Keep tests: a break shows far from the change or loses data.
- src/e2e.test.ts covers the whole system: processes, a fake provider,
  restarts and rejoins. Extend it rather than adding another.

Tests never use the network. Fake a provider only with responses
recorded from the real one; check new provider behavior against the
real API once, by hand.

Delete a flaky test: one that sometimes fails without a bug teaches
everyone to ignore red. Never retry, lengthen its timeout or skip it.

Test behavior and invariants, not implementation. Avoid source-text
assertions, repeated constants or templates, and tests that restate
one-line functions. Keep exact-output tests for format contracts (such
as ASON).

# Code

Hal is efficient: small, quick to start, light on CPU, memory, network
and tokens. Treat it so, keep it so, and measure before calling
anything costly.

Climb the lazy ladder: skip unnecessary code; prefer the standard
library, native platform features (Bun, Web APIs), installed
dependencies, one line, then the minimum code that works. Avoid new
dependencies, especially on the host path. Never cut trust-boundary
validation, data-loss handling, security, accessibility or explicit
requirements.

## Module initialization and navigation

Cyclic imports are allowed within the layer boundaries. Read imported
values inside functions, after module initialization, through the module
object. Keep derived values callable: prefer
`function x() { return f(other.value) }` to module-level
`const x = f(other.value)` or `const x = other.value`. This also applies
to destructuring and method aliases captured in exported objects.
Literal constants and local snapshots inside functions are fine.

Core functions have concrete, navigable implementations. Do not overwrite
functions with another implementation.

Avoid indirection without useful meaning: call `ansi.INVERSE`, not a
local alias of it, and import the module that implements a function
instead of an object that only forwards it.

## Plugins

Hal hot-reloads plugins/*.ts when they change; no restart is needed.

## Tools

Teach one obvious syntax in prompts, HELP and examples. Accept observed
deviations when the request has only one possible meaning; preserve
validation, security checks and data-loss handling. Use benchmarks to
find rejected but unambiguous calls, add the needed leniency and cover
the observed case with a focused regression test. Reject ambiguous calls
with an explanation and the canonical syntax.

## Design checks

- Add Hal capabilities behind the native `tool`, including in plugins
  and benchmark builds. Provider-hosted search is an exception for
  explicitly supported models when Serper is unavailable (task a0z).
  Tools disclose detail progressively (HELP) and let Hal's tool set
  change without busting the prompt cache.
- When you add or change a slash command, its `complete` offers every
  subcommand, flag and enumerable argument, as plain values like the
  other commands.
- Configure with command-line flags (e.g. `hal --no-user`), never
  environment variables: they hide information and are hard to
  discover and cumbersome to use. Replace an existing one with a flag
  when you touch it. Core code parses arguments in one place,
  src/client/args.ts; scripts/ may parse their own.
- The user is king. Hal's rules (UI, look, layout, tasks/) describe
  Hal's defaults, not limits on what the user may want. Never answer a
  wish with what Hal "won't" do: build it. Make hooks able to change
  any default. When a request changes a tracked default, name the rule
  it replaces once, then do it and update that rule. Plugins may do
  anything the user wants, even what Hal's rules forbid (unreadable
  text, dim, fades): the rules bind Hal's defaults, not the user.
- Do not invent requirements. Trace each requirement and its rationale
  to the user's request or a concrete constraint; distinguish design
  choices from requirements. Current behavior is not a requirement.
- Before finishing, ask: "What does this cost after a day? With 10×
  the data?" Check repeated work, elapsed-time loops and growing state.

# Multiple agents sharing a checkout

Agents in the same checkout share files and the Git index, even without
using `git worktree`. Stage only your changes: never `git add -A` or
whole files containing others' edits. Never discard uncommitted work
with `git checkout` or `git restore`. `git commit <paths>` commits whole
files, including others' uncommitted edits in them. If others edited a
file you changed, stage only your hunks (`git add -p`, or a blob via
`git update-index --cacheinfo`), check `git diff --cached`, then run
`git commit` without paths.

Other sessions may work in your directory. Avoid modifying files you
know someone else is editing. Assume idle tabs no longer own files;
contact them only for relevant context or new work.

## Orchestration

Work directly by default. Use subagents only when the gain outweighs
the extra tokens, delay and coordination:

- Parallel work: substantial, independent tasks with separate files.
- Independent review: a fresh assessment of a risky change or disputed
  conclusion, not routine approval.
- Context isolation: a lengthy investigation whose useful result is a
  short report, keeping noise out of the main session.

Do not delegate routine searches, small edits or tightly coupled work.
Task count alone is no reason. State the benefit before spawning; use
the fewest agents needed. Do not duplicate their work while they run.

Use a fresh subagent for each delegated implementation. The parent
reviews and integrates the result; each implementer re-runs ./test before
pushing.

# Progress reports

Keep reports to one screen. Measure every number now (git log,
`scripts/sloc . HEAD`, `tsk ls`, a test-case count, `scripts/cost`;
`scripts/sloc ~/.hal <rev>` for the old Hal), never from memory:

1. A feature map in a code block: what exists, a 12-cell bar
   (█ done, ░ missing, labeled as estimates), and what's missing.
2. A timeline in a code block: one line per run, with date, task count,
   changes and source lines; mark the latest "← now".
3. A table against the previous report: source lines, tests, tasks
   done/planned, questions answered; when the old Hal reached the same
   size; cost since the last report and in total.
4. A numbered list of decisions, unrestarted work and security issues
   needing the user.

# UI: one set of rules for web and terminal

The web and the terminal obey the same UI rules unless a task records
an exception. When changing behavior on one, consider whether the other
should change too, and always ask the user; never assume either way.
Colors are the exception: they match everywhere, so change both without
asking.

# UI: visible plumbing

Never hide an error. Every failure reaches the user complete: message,
provider body, raw input, path. Store it with the session and show it
where it happened. A failure is never reduced to a headline or dropped
between layers. A failure the model can act on also goes to the model
as a tool error, so the turn continues.

Show everything relevant once: identifiers users act on, file paths,
failures and complete output. Omit what nobody reads, such as tool call
IDs, argument types and restated defaults; session files keep them.
A closed tool says concisely what it does; opening it shows the detail
and the whole output. Bash reads like a terminal: `$ command` (`&` when
backgrounded), declared files as "Edits a.ts, src/*.ts", then streaming
output. Show non-default controls, invalid or unfamiliar arguments and
why Hal rejected a call. Use readable text, not JSON/ASON.
