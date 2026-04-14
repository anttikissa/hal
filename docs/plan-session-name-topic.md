# Plan: session name, topic, and `/rename`

## Goal

Split today's overloaded "tab title" concept into two separate things:

- **name** — a short, user-chosen handle for referring to a session
- **topic** — a longer human reminder of what the session is about

This gives us:

- `/rename` for stable short aliases
- later `/topic` for a readable summary when many tabs are open
- command targets that work by **tab number**, **session id**, or **name**

## Proposed data model

Extend session metadata with:

```ts
interface SessionMeta {
	id: string
	workingDir?: string
	createdAt: string
	name?: string
	topic?: string
	...
}
```

Rules:

- `name` defaults to **undefined**
- if `name` is undefined, the practical visible fallback name is the **session id** (`04-81g`)
- `topic` also defaults to **undefined**
- `name` and `topic` are independent
- `/rename` changes only `name`
- later `/topic` changes only `topic`
- **do not rename the session directory** on disk
	- session id remains the durable identity
	- filesystem paths and blob/history ownership stay unchanged

## Meaning of each field

### `name`

Use for:

- referring to a tab in commands
- short labels in tab chrome
- stable human handles like `pause-fix`, `billing`, `research-3`

Properties we want:

- short
- memorable
- user-controlled
- intended to be typed

### `topic`

Use for:

- reminding the user what a session is about
- long-form summaries when many tabs are open
- maybe later auto-generated / model-maintained summaries

Properties we want:

- descriptive
- allowed to change over time
- not intended as the main command target

## `/rename`

Add:

- `/rename <name>` — set the current session name
- `/rename` with no args — show current name and fallback behavior
- `/rename clear` or `/rename -` — clear the name back to undefined

Recommended behavior:

- persist to `session.ason`
- update tab chrome immediately
- keep session id unchanged
- do not touch cwd, topic, or history layout

Suggested visible feedback:

- `Renamed session to pause-fix`
- `Cleared session name; using 04-81g`

## Later: `/topic`

Not implementing yet, but reserve the model now.

Add later:

- `/topic <text>` — set topic
- `/topic` — show current topic
- `/topic clear` or `/topic -` — clear topic

The agent may eventually update `topic` automatically, but only as a future feature.
That needs careful prompting and overwrite rules, because bad auto-topics are worse than none.

## Session selector rules

Anywhere we currently accept a session id should eventually accept:

1. **tab number** where it already makes sense
2. **session id** (`04-81g`)
3. **session name** (`pause-fix`)

Examples:

- `/send 3 hello`
- `/send 04-81g hello`
- `/send pause-fix hello`
- `/resume pause-fix`

Recommendation:

- treat session id as the canonical identity
- resolve names only as a convenience layer
- if a name is ambiguous, fail with a clear error
- never silently pick one of several matches

Example error:

- `Session name "research" is ambiguous: 04-aaa, 04-bbb`

## Name syntax

This is the main design choice.

### Recommendation for v1

Allow spaces, but keep the charset modest:

- letters
- digits
- spaces
- `-`, `_`, `.`

Disallow:

- control characters
- tabs/newlines
- quotes for now
- path separators

Suggested normalization:

- trim outer whitespace
- collapse repeated spaces to one
- preserve original case for display
- compare **case-insensitively** for lookup

This gives us names like:

- `pause-fix`
- `billing`
- `research 3`
- `OpenAI auth`

but avoids awkward quoting and parser complexity in v1.

### Why not allow arbitrary strings immediately?

Because command parsing gets annoying fast:

- `/send "foo bar" hello`
- `/resume "abc"`
- names containing quotes/backslashes need escaping rules
- external CLI tools would need the same parser

We can add shell-like quoting later if we want full free-form names.
For the first version, constrained names are simpler and safer.

## Name uniqueness

Recommended rule:

- names do **not** need to be globally unique forever
- but duplicate names should be discouraged
- resolution must error on ambiguity

Practical policy:

- when renaming, warn if another open session already uses the same normalized name
- still allow it if we want flexibility, but command lookup must reject ambiguous matches

Alternative stricter policy:

- require uniqueness among open sessions

Recommendation: start with **ambiguity error**, not hard uniqueness.
It is simpler to migrate and less annoying.

## Display rules in tab bar

Today tab labels are too one-dimensional. We want adaptive labels based on available width.

Pieces available:

- tab index
- directory basename
- session name if set, else session id fallback
- later maybe topic, but not as a default tab-bar element

### Preferred order of importance

1. tab index
2. session name if set, else session id
3. directory basename
4. topic (future, optional only in very wide layouts)

### Proposed adaptive forms

When there is plenty of room:

- `[1 .hal pause-fix]`
- `[2 repo 04-81g]` if no explicit name

When room is moderate:

- `[1 pause-fix]`
- `[2 04-81g]`

When room is very tight:

- `[1 fix]` if clipped
- otherwise preserve index and clip the rest with `visLen()` rules

Important:

- all width decisions must use `visLen()`
- clipping should prefer dropping **directory** before dropping **name**
- session id fallback should always remain available if no name exists

### Why prioritize `name` over directory?

Because `name` is the user's explicit handle.
Directory is useful context, but the short alias should win once the user bothered to set it.

## Topic display ideas (future)

`topic` should not be forced into the normal tab label on 80-column terminals.
It is too long and too volatile.

Better future uses:

- popup / session list view
- widened tab labels only when there is lots of room
- status/sidebar view
- `/ls` or `/sessions` output

Possible wide rendering later:

- `[1 .hal pause-fix — startup/fork transcript blocks]`

But not v1.

## Command parser impact

Commands that should learn name resolution:

- `/send`
- `/resume`
- `/open <after>` if we keep targeted open
- future `/close <target>` if added
- future `/focus <target>` or `/switch <target>` if added

Implementation suggestion:

- centralize target resolution in one helper
- parse selectors consistently everywhere
- keep session id support untouched
- add name lookup on top

Pseudo-resolution:

```ts
resolveSessionSelector(raw, { allowTabNumber, includeClosed })
```

Return:

- exact session match
- or clear error: not found / ambiguous

## Migration from current `topic` usage

Right now `topic` is doing double duty as the visible title.
We should stop overloading it.

Recommended migration:

1. add `name?: string`
2. leave existing `topic` values alone
3. display priority becomes:
	- `name`
	- else session id fallback for naming purposes
	- topic is separate
4. later decide whether old `topic` values should be copied into `name` once, or just remain as topics

Recommendation:

- **do not auto-copy existing `topic` into `name`**
- keep semantics clean going forward
- if we want migration, do it with an explicit script or one-time rule

## Suggested rollout order

### 1. Session metadata

- add `name?: string`
- load/save it in `session.ason`

### 2. `/rename`

- set/show/clear current session name
- update tab display immediately

### 3. Selector resolution

- let `/send` and `/resume` accept name
- keep ids and tab numbers working exactly as before

### 4. Adaptive tab labels

- display `[index dir name]` when wide
- `[index name]` when narrower
- fallback to session id if name is undefined

### 5. Later `/topic`

- separate command
- separate rendering path
- maybe later model-assisted maintenance

## Open questions

1. Should `/rename` enforce uniqueness among open sessions, or only error on ambiguous lookup?
	- recommendation: allow duplicates, error on ambiguity

2. Should names be case-sensitive for display but case-insensitive for lookup?
	- recommendation: yes

3. Should names allow spaces?
	- recommendation: yes

4. Should names allow quotes?
	- recommendation: not in v1

5. Should `/resume <name>` search closed sessions by name too?
	- recommendation: yes, but if ambiguous, error loudly

6. Should topic ever appear in the default 80-col tab bar?
	- recommendation: no, not by default

## Bottom line

- add **`name`** as a real session field
- keep default name **undefined** and fall back to **session id** in UI
- make `/rename` set that short commandable alias
- let command targets accept **tab number / session id / name**
- keep **`topic`** as a separate future long-form reminder, not the main session handle
