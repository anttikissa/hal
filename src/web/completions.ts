// Browser completion menu decisions. Candidate strings come from the host's
// shared completion source; the shared formatter supplies their short labels.
import { commandList } from '../common/commands/list.ts'
import { completion } from '../common/completion.ts'

export type Choice = { value: string; label: string; description: string }
export type Menu = { input: string; choices: Choice[]; selected: number; explicit?: boolean }
export type Known = { input: string; items: string[]; descriptions?: string[] }

// Use the host's full candidate set for a longer prefix while its next
// answer is in flight. A shorter prefix might have additional matches.
function predict(text: string, known: Known | undefined, current?: Menu): Menu | undefined {
	if (!known || !text.startsWith(known.input)) return current
	return completions.receive(text, known.items.filter((item) => item.startsWith(text)), current, known.descriptions?.filter((_, i) => known.items[i]!.startsWith(text)))
}

function receive(input: string, items: string[], previous?: Menu, descriptions?: string[]): Menu | undefined {
	if (!items.length) return undefined
	let short = completion.apply(input, items).choices
	let choices = items.map((value, i) => {
		let name = value.trimEnd().split(' ')[0]!
		let label = short?.[i] ?? (name === value.trimEnd() ? name : value.slice(value.lastIndexOf(' ') + 1))
		// Only the host or the command list describes a candidate (task 4qh).
		let description = descriptions?.[i] || (name === value.trimEnd() ? commandList.byName(name.slice(1))?.description : undefined) || ''
		return previous?.choices.find((choice) => choice.value === value && choice.label === label && choice.description === description) ?? { value, label, description }
	})
	if (previous && choices.length === previous.choices.length && choices.every((choice, i) => choice === previous.choices[i])) return previous
	let selected = previous ? choices.findIndex((choice) => choice.value === previous.choices[previous.selected]?.value) : -1
	return { input, selected: Math.max(0, selected), choices, explicit: selected >= 0 && previous?.explicit }
}

function step(menu: Menu, direction: number): Menu {
	return { ...menu, explicit: true, selected: (menu.selected + direction + menu.choices.length) % menu.choices.length }
}

// Passive highlighting cannot replace an exact registered command's text.
function chooses(text: string, menu?: Menu): boolean {
	return !!menu && (!!menu.explicit || !commandList.byName(/^\/(\S+)/.exec(text)?.[1] ?? ''))
}

export const completions = { receive, predict, step, chooses }
