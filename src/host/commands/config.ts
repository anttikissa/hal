// /config: the settings modal (common/settings-modal.ts), or a direct
// get/set. The modal's every change is a /config <name> <value>.
import { ason } from '../../common/ason.ts'
import { settings } from '../../common/settings.ts'
import type { SlashCommand } from '../commands.ts'
import { config } from '../config.ts'

function parsed(args: string): { name: string; value?: string } {
	let m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim())
	return { name: m?.[1] ?? '', ...(m?.[2] !== undefined && { value: m[2] }) }
}

export const command: SlashCommand = {
	help: () => '/config lists all settings to change.\n/config <name> shows one.\n/config <name> <value> sets one.\n\nDefaults are not stored.',
	complete: (args) => settings.table.filter((s) => s.name.startsWith(args)).map((s) => s.name),
	run(args) {
		config.init()
		let { name, value } = parsed(args)
		if (!name) return { open: 'settings' }
		let s = settings.table.find((s) => s.name === name)
		if (!s) return { error: `unknown setting '${name}'` }
		if (value === undefined) return { say: `${name}: ${String(settings.value(name))}` }
		let next = settings.fromText(s.type, value === '""' || value === "''" ? '' : value)
		let why = settings.problem(s.type, next)
		if (why) return { error: `${name}: ${why}` }
		let keys = config.update({ [name]: next })
		if (!keys.length) return { say: 'settings unchanged' }
		// The command line already shows the value; say only what it doesn't.
		let shown = typeof next === 'string' ? next : ason.stringify(next, 'short')
		let notes = [...(shown === value.trim() ? [] : [`${name}: ${shown}`]), ...(Object.is(next, s.default) ? ['The default: removed from config.ason.'] : [])]
		return notes.length ? { say: notes.join('\n') } : {}
	},
}
