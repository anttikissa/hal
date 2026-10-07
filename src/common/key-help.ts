// Every prompt, editing, clipboard and app key, with what it does: the
// one list /keys shows in both clients. Labels are the bindings
// themselves ("shift-ctrl-t", "ctrl--" for Ctrl and minus), parsed into
// Key-shaped bindings so a test can check each one is handled. Rows of
// commands with a key come from the command list (common/commands/).

import { commandList } from './commands/list.ts'
import { sendKeys } from './send-keys.ts'

export type Binding = { key: string; shift: boolean; alt: boolean; ctrl: boolean; cmd: boolean }
export type KeyRow = { keys: string; description: string; bindings: Binding[]; command?: string }
export type KeySection = { title: string; rows: KeyRow[] }

// "shift-ctrl-t" → t with Shift and Ctrl; the key is what follows the
// last modifier, so "ctrl--" is Ctrl and "-".
function parse(label: string): Binding {
	let m = /^((?:(?:shift|alt|ctrl|cmd)-)*)(.+)$/.exec(label)!
	let mods = m[1]!
	let has = (mod: string) => mods.includes(`${mod}-`)
	return { key: m[2]!, shift: has('shift'), alt: has('alt'), ctrl: has('ctrl'), cmd: has('cmd') }
}

// `keys`: labels joined by " / "; `sums`: the bindings, where the label
// only sums them up.
function row(keys: string, description: string, sums?: string[]): KeyRow {
	let labels = sums ?? keys.split(' / ')
	return { keys, description, bindings: labels.map((l) => keyHelp.parse(l)) }
}

// The row of command `name`, which has a key.
function command(name: string): KeyRow {
	let c = commandList.byName(name)!
	return { ...row(c.key!, c.description), command: c.keyArgs ? `${name} ${c.keyArgs}` : name }
}

const digits = [...'1234567890'].map((d) => `alt-${d}`)

function sections(): KeySection[] {
	return [
		{
			title: 'Prompt',
			rows: [
				row('enter', 'send the prompt; on an empty prompt, continue'),
				row(sendKeys.key('steer') ?? 'no key', 'while working: steer, stopping the reply and tools (not unsafe-to-stop or background ones); on an empty prompt, send the next queued message so'),
				row(sendKeys.key('soft-steer') ?? 'no key', 'while working: soft-steer, sent at the next step without stopping anything; on an empty prompt, send the next queued message so'),
				row('shift-enter', 'new line'),
				row(sendKeys.key('queue') ?? 'no key', 'queue the prompt to run after the turn'),
				row('escape', 'pause the turn; leave editing the last prompt'),
				row('up', 'on an empty prompt while working: edit the last prompt'),
				row('tab', 'complete a slash command; else insert a tab or indent the selection'),
				row('shift-tab', 'outdent the selected lines'),
				row('ctrl-/ / cmd-z / cmd-u', 'undo; on an empty prompt, queue again a message sent early'),
				row('shift-ctrl-/ / shift-cmd-z / shift-cmd-u', 'redo'),
			],
		},
		{
			title: 'Editing',
			rows: [
				row('left / right', 'move by character'),
				row('alt-left / alt-right', 'move by word'),
				row('up / down', 'move by row; past the edges, browse sent prompts'),
				row('home / end / ctrl-a / ctrl-e', 'start or end of the line'),
				row('cmd-left / cmd-right / alt-up / alt-down', 'start or end of the text'),
				row('shift-<move>', 'extend the selection', ['shift-left', 'shift-right', 'shift-up', 'shift-down', 'shift-home', 'shift-end']),
				row('backspace / delete / ctrl-d', 'delete a character (ctrl-d on an empty prompt quits)'),
				row('alt-backspace', 'delete the previous word'),
				row('ctrl-k / ctrl-u / alt-d', 'kill to line end, line start, word end'),
				row('ctrl-y', 'yank the last killed text'),
				row('ctrl-= / ctrl-up', 'grow the prompt box'),
				row('ctrl-- / ctrl-down', 'shrink the prompt box'),
			],
		},
		{
			title: 'Clipboard',
			rows: [
				row('cmd-a', 'select all'),
				row('cmd-c', 'copy the selection'),
				row('cmd-x', 'cut the selection'),
				row('ctrl-v / cmd-v', 'paste text, or attach an image'),
			],
		},
		{
			title: 'Tabs and app',
			rows: [
				command('new'),
				command('fork'),
				command('resume'),
				command('close'),
				row('ctrl-n / ctrl-p', 'next or previous tab'),
				row('alt-1 … alt-0', 'tab 1 to 10', digits),
				command('model'),
				command('find'),
				command('toggle'),
				command('redraw'),
				command('quit'),
				command('suspend'),
				command('restart'),
				command('keys'),
			],
		},
	]
}

// One keys column and one command column across all sections, so the
// descriptions line up.
function render(): string {
	let rows = keyHelp.sections().flatMap((s) => s.rows)
	let keys = Math.max(...rows.map((r) => r.keys.length))
	let names = Math.max(...rows.map((r) => (r.command ? r.command.length + 1 : 0)))
	let parts = ['Keys:']
	for (let section of keyHelp.sections()) {
		parts.push('', `${section.title}:`)
		for (let r of section.rows) parts.push(`  ${r.keys.padEnd(keys)}  ${(r.command ? `/${r.command}` : '').padEnd(names)}  ${r.description}`)
	}
	return parts.join('\n')
}

export const keyHelp = { parse, sections, render }
