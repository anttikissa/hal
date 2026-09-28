// Browser completion menu decisions. Candidate strings come from the host's
// shared completion source; the shared formatter supplies their short labels.
import { commandList } from '../common/commands/list.ts'
import { completion } from '../common/completion.ts'

export type Choice = { value: string; label: string; description: string }
export type Menu = { input: string; choices: Choice[]; selected: number }

function receive(input: string, items: string[]): Menu | undefined {
	if (!items.length) return undefined
	let short = completion.apply(input, items).choices
	return { input, selected: 0, choices: items.map((value, i) => {
		let name = value.trimEnd().split(' ')[0]!
		return { value, label: short?.[i] ?? (name === value.trimEnd() ? name : value.slice(value.lastIndexOf(' ') + 1)), description: (name === value.trimEnd() ? commandList.byName(name.slice(1))?.description : undefined) ?? (value.endsWith('/') ? 'directory' : 'path') }
	}) }
}

function step(menu: Menu, direction: number): Menu {
	return { ...menu, selected: (menu.selected + direction + menu.choices.length) % menu.choices.length }
}

export const completions = { receive, step }
