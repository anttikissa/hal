---
name: plugin-tools
description: Add a tool to Hal as a plugin (plugins/*.ts) that looks and feels like a built-in one - its card title, raw command row, kind, color and icon. Use whenever you write or change a plugin tool.
---

# Plugin tools

A plugin adds a tool in one line; Hal reloads plugins/*.ts on save:

```ts
import type { Plugin } from 'hal/host/plugins.ts'
import { tools, type Tool } from 'hal/host/tools.ts'

export default (plugin: Plugin) => {
	plugin.around(tools, 'all', (next) => [...next(), sqlTool])
}

const sqlTool: Tool = {
	name: 'sql', // the model calls SQL; one lowercase word
	description: 'Query a SQLite database, read-only. Returns rows as a table.',
	parameters: {
		type: 'object',
		properties: {
			db: { type: 'string', description: 'Database file' },
			query: { type: 'string', description: 'One SELECT statement' },
		},
		required: ['db', 'query'],
	},
	readOnly: true,
	card: { command: 'query', language: 'sql', icon: 'database', title: (input) => String(input.db) },
	syntax: { summary: 'query a SQLite database', usage: ['SQL "app.db" "select count(*) from users"'] },
	run: async (input) => { /* ... */ return table },
}
```

Import Hal modules as `hal/<dir>/<file>.ts` (it resolves to the
running Hal wherever the plugin lives), never by relative path. Before
saving, run the tool's core logic once in a scratch `bun` script: a
plugin that loads can still fail on its first call. After saving, run
`/plugins`: the file's row lists its hooks or its full error. Then
call the tool once.

## The card

Every plugin tool gets a card; `card` (Tool.card in src/host/tools.ts)
tunes it. Hal builds it on the host and records it with the call, so
history replays it even after the plugin is gone.

1. **Title**: as built-in titles read (`Google foo`, `Grep "x" in
   src`): the tool's name in sentence case, a space, then why the call
   ran: `Sql Count users`. The model's `/* purpose */` comment wins
   (HELP teaches it for every plugin tool), else `card.title(input,
   result?)` - what the call works on (`app.db`; with the result, what
   it found). Never the raw command.
2. **Second row**: `card.command` names the input field holding a raw
   command (code, a query, a shell line). It shows as code; a closed
   card shows its first line. Other arguments follow as `key: value`
   lines.
3. **Body**: the result, in full. A failure shows complete, once: to
   fail, throw; Hal reports the error with its stack.

## Kind and color

The kind sets the color. `readOnly: true` when running the tool changes
nothing: such calls run in parallel, and edited prompts may replay
them; the card is READ's green. Otherwise the tool has side effects,
runs in order, and the card is BASH's purple. When unsure, leave
readOnly off.

Leave `card.hue` unset. Set it only when the user asks for a color,
and let the user pick the hue. `hue` is the OKLCH hue alone; lightness
and chroma are shared by all tools, so every hue stays readable: the
title and command at `[fgL 0.84, fgC 0.17, hue]`, the card at
`[bgL 0.2, bgC 0.05, hue]`, output darker at the same chroma. Taken
hues: 25-35 errors, 55 info, 75-100 Hal and warnings, 155 read, 215
user, 320 bash, 350 messages. Free: 120-130 lime, 175-195 teal, 240-295
blue to violet.

## Icon

The web shows `card.icon` before the title; default `sparkle`.
Plugin icons: `sparkle`, `code`, `database`, `terminal`, `checklist`,
`camera`. Built-in ones work too: `read`, `web`, `google`, `bug`,
`image`, `message`, `bell`. A new icon goes in src/web/icons.ts, from
Phosphor Regular.

## Four examples

| Tool | Kind, color | Title | Second row | Body | Icon |
|---|---|---|---|---|---|
| sql | read-only, green | `Sql app.db` | the query | rows as a table | `database` |
| python | side effect, purple | `Python <purpose>` | Python code | stdout, stderr | `terminal` |
| task | read-only, green | `Task m3a: <title>` from the result | - | spec, notes | `checklist` |
| screenshot | read-only, green | `Screenshot <url> at 390 px` | - | saved path, image | `camera` |

## Beyond the card

For a fully custom card (diffs, several files), wrap
`toolPresentations.present` (src/host/tool-presentation.ts).
