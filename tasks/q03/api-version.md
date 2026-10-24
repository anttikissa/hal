# Plugin API versions

`plugin-api.ason` records the current integer API version and changes
since version 1. It is independent of Hal releases and commit IDs.
The first version records changes; the plugin loader does not yet use
this ledger or provide compatibility adapters.

## When committing Hal changes

The implementing agent classifies the change while its intent is fresh.
Every commit message includes a `Plugin-API` declaration. If plugin-visible
behavior is unchanged, including a behavior-preserving refactor:

```
Plugin-API: none
```

Otherwise repeat the field for each affected contract:

```
Plugin-API: rename host/tools.all -> host/tools.list
Plugin-API: compatible host/tools.Tool | Adds optional field label
Plugin-API: breaking host/files.write | Returns before completion
  | Await result.done before reading the file
```

Targets name modules relative to `src/`, without the extension, followed
by the exported member when applicable. They can describe functions,
types, values or nested fields. Renames of whole modules are allowed.
Descriptions use plain English; `|` separates fields. Use indented
continuation lines for wrapping.

- `rename old -> new` records a move or rename with unchanged behavior.
- `compatible target | description` records an addition that preserves
  existing use but may matter to a plugin running on an older Hal.
- `breaking target | description | port instructions` records a contract
  change requiring adaptation. Describe what changed and what to do.

A new return value or optional argument does not itself require a
migration entry. Use `compatible` if newer plugins need to identify the
new capability. A required argument or changed default may be breaking.
Check callers and tests; signatures alone do not establish compatibility.
A rename record is information, not proof that a working adapter exists.

## What the hook does

The `commit-msg` hook installed through `bun install` requires the
explicit declaration, validates its structure and rejects contradictory
entries. It prepares one new version for a nonempty batch, automatically
staging only `plugin-api.ason`. Git has already built the commit tree at
this point, so the hook stops the commit. Review the generated ledger
and repeat the commit; the second attempt includes it without another
increment. With explicit commit paths, include `plugin-api.ason` too.
Commits declaring `none` need no second attempt. The hook does not infer
semantics or inspect private plugins. The existing size check still runs.

The hook uses the index, not unstaged source. It refuses to overwrite
unstaged ledger changes or rewrite committed history. If the declaration
changes after preparation, reconcile the staged pending entry first.
A message-only amendment preserves the version; an amendment with a new
declared API change adds another version.

Branches can independently choose the same next integer. Reconcile and
renumber unpublished entries when integrating them; published version
history is append-only. No Git traversal or model call is needed when
reading the resulting ledger. Git hooks can be bypassed; this workflow
is a development contract, not a security boundary.
