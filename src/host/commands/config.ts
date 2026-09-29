// /config: the shared settings table as one question, or a direct get/set.
// A form carries its non-secret baseline in askArgs so an unchanged field
// never overwrites an external edit made while the question was open.
import { settings, type Setting } from '../../common/settings.ts'
import type { Answers, Field, Form } from '../../common/forms.ts'
import type { SlashCommand } from '../commands.ts'
import { config } from '../config.ts'

function parsed(args: string): { name: string; value?: string } {
	let m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
	return { name: m?.[1] ?? '', ...(m?.[2] !== undefined && { value: m[2] }) }
}

function converted(s: Setting, text: string): unknown {
	if (s.type.kind === 'integer') return /^-?\d+$/.test(text) ? Number(text) : NaN
	if (s.type.kind === 'boolean') return text === 'true' ? true : text === 'false' ? false : text
	return text
}

function changed(args: string, answers: Answers): Record<string, unknown> {
	let baseline: Answers = args.startsWith('@') ? JSON.parse(args.slice(1)) : {}
	let values: Record<string, unknown> = {}
	for (let s of settings.table) {
		let text = answers[s.name]
		if (text === undefined || text === baseline[s.name] || (s.type.kind === 'secret' && text === '')) continue
		values[s.name] = converted(s, text)
	}
	return values
}

function check(args: string, answers: Answers): string | undefined {
	let values = changed(args, answers)
	for (let s of settings.table) {
		if (!(s.name in values)) continue
		let why = settings.problem(s.type, values[s.name])
		if (why) return `${s.name}: ${why}`
	}
	return undefined
}

function question(): { ask: Form; askArgs: string } {
	let values = settings.check(settings.state.raw).values
	let baseline: Answers = {}
	let fields = settings.table.map((s): Field => {
		let common = { name: s.name, label: s.name, help: s.description }
		let text = s.type.kind === 'secret' ? '' : String(values[s.name])
		baseline[s.name] = text
		switch (s.type.kind) {
			case 'secret': return { ...common, type: 'secret', help: `${s.description} Leave empty to keep the current value.` }
			case 'text': return { ...common, type: 'text', initial: text }
			case 'integer': return { ...common, type: 'integer', initial: text }
			case 'choice': return { ...common, type: 'choice', options: s.type.options, initial: s.type.options.indexOf(text) }
			case 'boolean': return { ...common, type: 'choice', options: ['true', 'false'], initial: text === 'true' ? 0 : 1 }
		}
	})
	return { ask: { text: 'Settings', fields }, askArgs: '@' + JSON.stringify(baseline) }
}

export const command: SlashCommand = {
	help: () => '/config opens all settings. /config <name> shows one; /config <name> <value> sets one. Defaults are not stored. Secret values are never shown; leave their form field empty to keep them.',
	complete: (args) => settings.table.filter((s) => s.name.startsWith(args)).map((s) => s.name),
	checkAnswers: check,
	record(args) {
		let { name, value } = parsed(args)
		return `/config${name ? ` ${name}` : ''}${value !== undefined ? settings.table.find((s) => s.name === name)?.type.kind === 'secret' ? ' (given)' : ` ${value}` : ''}`
	},
	run(args, answers) {
		config.init()
		if (answers) {
			let why = command.checkAnswers!(args, answers)
			if (why) return { error: why, ...question() }
			let keys = config.update(changed(args, answers))
			return { say: keys.length ? `changed: ${keys.join(', ')}` : 'settings unchanged' }
		}
		let { name, value } = parsed(args)
		if (!name) return question()
		let s = settings.table.find((s) => s.name === name)
		if (!s) return { error: `unknown setting '${name}'` }
		if (value === undefined) return { say: `${name}: ${s.type.kind === 'secret' ? '(hidden)' : String(settings.value(name))}` }
		let next = converted(s, value === '""' || value === "''" ? '' : value)
		let why = settings.problem(s.type, next)
		if (why) return { error: `${name}: ${why}` }
		let keys = config.update({ [name]: next })
		return { say: keys.length ? `changed: ${name}` : 'settings unchanged' }
	},
}
