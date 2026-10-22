---
name: plugin-tools
description: Add a tool to Hal as a plugin (plugins/*.ts) that looks and feels like a built-in one - its card title, raw command row, kind, color and icon. Use whenever you write or change a plugin tool.
---

# Plugin tools

A plugin adds a tool in one line; Hal reloads plugins/*.ts on save:

```ts
import type { Plugin } from '../src/host/plugins.ts'
import { tools, type Tool } from '../src/host/tools.ts'

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
	card: { command: 'query', language: 'sql', icon: 'database', title: (input) => `Query ${input.db}` },
	syntax: { summary: 'query a SQLite database', usage: ['SQL "app.db" "select count(*) from users"'] },
	run: async (input) => { /* ... */ return table },
}
```

## The card

Every plugin tool gets a card; `card` (Tool.card in src/host/tools.ts)
tunes it. Hal builds it on the host and records it with the call, so
history replays it even after the plugin is gone.

1. **Title**: why the call ran. The model's `/* purpose */` comment wins
   (HELP teaches it for every plugin tool), else `card.title(input,
   result?)` - what the call works on ('Query app.db'; with the result,
   what it found) - else the tool's name. Never the raw command.
2. **Second row**: `card.command` names the input field holding a raw
   command (code, a query, a shell line). It shows as code, whole.
   Other arguments follow as `key: value` lines.
3. **Body**: the result, in full. A failure shows complete, once.

## Kind

`readOnly: true` when running the tool changes nothing: such calls run
in parallel, and edited prompts may replay them. Otherwise it has side
effects and runs in order. When unsure, leave readOnly off.

## Color

Without `card.hue`, read-only tools share READ's green and others
BASH's purple. That is the right default; give a hue only to a tool
used often enough that users learn its color. Ask the user which hue.

`hue` is the OKLCH hue alone. Lightness and chroma are shared by all
tools, so every hue stays readable (contrast above 5:1): the title and
command at `[fgL 0.84, fgC 0.17, hue]`, the card at
`[bgL 0.2, bgC 0.05, hue]`, output darker at the same chroma. Taken
hues, to avoid: 25-35 errors, 55 info, 75-100 Hal and warnings, 155
read, 215 user, 320 bash, 350 messages. Free: 120-130 lime, 175-195
teal, 240-295 blue to violet.

## Icon

The web shows `card.icon` before the title; default `sparkle`.
Plugin icons: `sparkle`, `code`, `database`, `terminal`, `checklist`,
`camera`. Built-in ones work too: `read`, `web`, `google`, `bug`,
`image`, `message`, `bell`. A new icon goes in src/web/icons.ts, from
Phosphor Regular.

## Five examples

| Tool | Kind | Title | Second row | Body | Look |
|---|---|---|---|---|---|
| EVAL | side effect | purpose | JS code | inspected value | hue 265, `code` |
| SQL | read-only | `Query app.db` | the query | rows as a table | green, `database` |
| PYTHON | side effect | purpose | Python code | stdout, stderr | purple, `terminal` |
| TASK | read-only | `Task m3a: <title>` from the result | - | spec, notes | hue 125, `checklist` |
| SCREENSHOT | read-only | `Screenshot <url> at 390 px` | - | saved path, image | green, `camera` |

## Beyond the card

For a fully custom card (diffs, several files), wrap
`toolPresentations.present` (src/host/tool-presentation.ts).
