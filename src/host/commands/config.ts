// /config: the settings modal (common/settings-modal.ts), or a direct
// get/set. The modal's every change is a /config <name> <value>.
import { ason } from '../../common/ason.ts'
import { settings, type Setting } from '../../common/settings.ts'
import type { SlashCommand } from '../commands.ts'
import { config } from '../config.ts'

function parsed(args: string): { name: string; value?: string } {
	let m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
	return { name: m?.[1] ?? '', ...(m?.[2] !== undefined && { value: m[2] }) }
}

// The setting `args` names, the value it sets and why that value is
// refused, if it is.
function change(args: string): { s: Setting; next: unknown; why?: string } | undefined {
	let { name, value } = parsed(args)
	let s = settings.table.find((s) => s.name === name)
	if (!s || value === undefined) return undefined
	let next = settings.fromText(s.type, value === '""' || value === "''" ? '' : value)
	return { s, next, why: settings.problem(s.type, next) }
}

export const command: SlashCommand = {
	help: () =>
		'/config lists all settings to change.\n/config <name> shows one.\n/config <name> <value> sets one.\n\nDefaults are not stored.',
	complete: (args) => settings.table.filter((s) => s.name.startsWith(args)).map((s) => s.name),
	// Setting a stored key to its default removes it; the command line
	// says so: one row, no echo.
	// Bare /config only opens the modal: nothing to keep in history.
	record(args) {
		config.init()
		if (!parsed(args).name) return null
		let c = change(args)
		if (!c || c.why || !Object.is(c.next, c.s.default)) return undefined
		let stored = Object.keys(settings.state.raw).some((k) => k.replace(/^blockVerbosity/, 'cardVerbosity') === c.s.name)
		return stored ? `/config ${args.trim()} (the default - removed from config.ason)` : undefined
	},
	run(args) {
		config.init()
		let { name, value } = parsed(args)
		if (!name) return { open: 'settings' }
		let s = settings.table.find((s) => s.name === name)
		if (!s) return { error: `unknown setting '${name}'` }
		if (value === undefined) return { say: `${name}: ${String(settings.value(name))}` }
		let c = change(args)!
		if (c.why) return { error: `${name}: ${c.why}` }
		let keys = config.update({ [name]: c.next })
		if (!keys.length) return Object.is(c.next, s.default) ? {} : { say: 'settings unchanged' }
		// The command line already shows the value; say only what it doesn't.
		let shown = typeof c.next === 'string' ? c.next : ason.stringify(c.next, 'short')
		return shown === value.trim() ? {} : { say: `${name}: ${shown}` }
	},
}
