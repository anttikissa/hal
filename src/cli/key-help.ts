// Human-facing keyboard shortcut labels and /keys output.

type ShortcutRow = { keys: string; description: string }
type ShortcutSection = { title: string; rows: ShortcutRow[] }

function key(raw: string): string {
	return raw.replaceAll('-', '+')
}

function row(keys: string, description: string): ShortcutRow {
	return { keys: keys.split(' / ').map((item) => key(item)).join(' / '), description }
}

function sections(): ShortcutSection[] {
	return [
		{
			title: 'Prompt',
			rows: [
				row('enter', 'send prompt; continue/retry when the prompt is empty'),
				row('shift-enter', 'insert newline'),
				row('alt-enter', 'queue prompt for later'),
				row('ctrl-q', 'run queued prompts'),
				row('tab', 'complete slash commands, models, config keys, and paths'),
				row('ctrl-/ / cmd-z / cmd-u', 'undo'),
				row('shift-ctrl-/ / shift-cmd-z / shift-cmd-u', 'redo'),
			],
		},
		{
			title: 'Text editing',
			rows: [
				row('left / right', 'move cursor'),
				row('up / down', 'move between rows; browse history at prompt edges'),
				row('home / end', 'move to start/end of current line'),
				row('ctrl-a / ctrl-e', 'move to start/end of current line'),
				row('alt-left / alt-right', 'move by word'),
				row('shift-<movement>', "selects text (like you'd expect from any modern app)"),
				row('ctrl-up / ctrl-down', 'expand/shrink prompt editor height'),
				row('ctrl-u', 'kill to start of line; at line start, delete preceding newline'),
				row('ctrl-k', 'kill to end of line; at line end, delete following newline'),
				row('alt-d', 'kill next word'),
				row('alt-backspace', 'delete previous word'),
				row('ctrl-y', 'yank/paste last killed text'),
				row('ctrl-d', 'delete next character; quit if prompt is empty'),
			],
		},
		{
			title: 'Clipboard and selection',
			rows: [
				row('cmd-a', 'select all prompt text'),
				row('cmd-c', 'copy selection'),
				row('cmd-x', 'cut selection'),
				row('cmd-v / ctrl-v', 'paste'),
			],
		},
		{
			title: 'Tabs and app',
			rows: [
				row('ctrl-t', 'new tab'),
				row('shift-ctrl-t', 'reopen most recent closed tab'),
				row('ctrl-f', 'fork current tab'),
				row('ctrl-w', 'close tab'),
				row('ctrl-n / ctrl-p', 'next/previous tab'),
				row('alt-1', 'jump to tab 1 (use 2 … 9 for other tabs)'),
				row('alt-0', 'jump to tab 10'),
				row('ctrl-m / alt-m', 'model picker'),
				row('esc', 'stop current generation'),
				row('ctrl-l', 'redraw'),
				row('ctrl-c', 'quit'),
				row('ctrl-z', 'suspend'),
			],
		},
	]
}

function render(): string {
	const parts = ['Keyboard shortcuts:']
	for (const section of keyHelp.sections()) {
		parts.push('', `${section.title}:`)
		const width = Math.max(...section.rows.map((item) => item.keys.length))
		for (const item of section.rows) parts.push(`  ${item.keys.padEnd(width)}  ${item.description}`)
	}
	return parts.join('\n')
}

export const keyHelp = {
	key,
	sections,
	render,
}
