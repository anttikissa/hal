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
	help: () => '/config lists all settings to change. /config <name> shows one; /config <name> <value> sets one. Defaults are not stored. Secret values are never shown.',
	complete: (args) => settings.table.filter((s) => s.name.startsWith(args)).map((s) => s.name),
	record(args) {
		let { name, value } = parsed(args)
		return `/config${name ? ` ${name}` : ''}${value !== undefined ? settings.table.find((s) => s.name === name)?.type.kind === 'secret' ? ' (given)' : ` ${value}` : ''}`
	},
	run(args) {
		config.init()
		let { name, value } = parsed(args)
		if (!name) return { open: 'settings' }
		let s = settings.table.find((s) => s.name === name)
		if (!s) return { error: `unknown setting '${name}'` }
		if (value === undefined) return { say: `${name}: ${s.type.kind === 'secret' ? '(hidden)' : String(settings.value(name))}` }
		let next = settings.fromText(s.type, value === '""' || value === "''" ? '' : value)
		let why = settings.problem(s.type, next)
		if (why) return { error: `${name}: ${why}` }
		let keys = config.update({ [name]: next })
		if (!keys.length) return { say: 'settings unchanged' }
		if (s.type.kind === 'secret') return { say: `${name}: (given)` }
		return { say: Object.is(next, s.default) ? `${name}: ${ason.stringify(next, 'short')} (the default: removed from config.ason)` : `${name}: ${ason.stringify(next, 'short')}` }
	},
}
