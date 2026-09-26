// Common settings: the one table of what config.ason (home root) may
// hold. The table validates the file, documents it, and is what /config
// renders: each type maps to a form field (tasks/w4/forms.md). Anything
// not here is set by overriding functions from local.ts, which may also
// replace these getters.
//
// Code reads settings.<name>() at call time; host/config.ts keeps
// state.raw pointing at the live file, so edits apply at once. A bad
// value or unknown key is a warning and that setting uses its default.

export type SettingType =
	| { kind: 'text' }
	| { kind: 'secret' }
	| { kind: 'integer'; min: number; max: number }
	| { kind: 'choice'; options: string[] }

export type Setting = { name: string; type: SettingType; default: unknown; description: string }

const table: Setting[] = [
	{ name: 'model', type: { kind: 'text' }, default: 'anthropic/claude-opus-5-5', description: 'Default model (provider/id) for new sessions.' },
	{
		name: 'security',
		type: { kind: 'choice', options: ['best-effort', 'none'] },
		default: 'best-effort',
		description: 'Ask before tool calls matching dangerous patterns (best-effort), or never (none).',
	},
	{ name: 'webPassword', type: { kind: 'secret' }, default: 'hello123', description: 'Password for the browser client.' },
	{ name: 'webPort', type: { kind: 'integer', min: 1, max: 65535 }, default: 9002, description: 'Port for the browser client (127.0.0.1).' },
]

// Why `value` doesn't fit `type`, or undefined if it does.
function problem(type: SettingType, value: unknown): string | undefined {
	switch (type.kind) {
		case 'text':
		case 'secret':
			return typeof value === 'string' && value !== '' ? undefined : 'expected a non-empty string'
		case 'integer':
			return Number.isInteger(value) && (value as number) >= type.min && (value as number) <= type.max
				? undefined
				: `expected an integer ${type.min}–${type.max}`
		case 'choice':
			return type.options.includes(value as string) ? undefined : `expected one of ${type.options.map((o) => `'${o}'`).join(', ')}`
	}
}

// Every declared setting's effective value, plus a warning for each
// unknown key or bad value. Never throws.
function check(raw: Record<string, unknown>): { values: Record<string, unknown>; warnings: string[] } {
	let values: Record<string, unknown> = {}
	let warnings: string[] = []
	for (let s of settings.table) {
		values[s.name] = s.default
		if (!(s.name in raw)) continue
		let why = problem(s.type, raw[s.name])
		if (!why) values[s.name] = raw[s.name]
		else {
			// Secrets are never echoed, not even malformed ones.
			let got = s.type.kind === 'secret' ? '' : `, got ${JSON.stringify(raw[s.name]) ?? String(raw[s.name])}`
			warnings.push(`${s.name}: ${why}${got}; using the default`)
		}
	}
	for (let key of Object.keys(raw)) {
		if (!settings.table.some((s) => s.name === key)) warnings.push(`unknown setting '${key}', ignored`)
	}
	return { values, warnings }
}

function value(name: string): unknown {
	return settings.check(settings.state.raw).values[name]
}

export const settings = {
	// The parsed config file (a live object on the host); {} means defaults.
	state: { raw: {} as Record<string, unknown> },
	table,
	check,
	value,
	warnings: (): string[] => settings.check(settings.state.raw).warnings,
	model: (): string => settings.value('model') as string,
	security: (): 'best-effort' | 'none' => settings.value('security') as 'best-effort' | 'none',
	webPassword: (): string => settings.value('webPassword') as string,
	webPort: (): number => settings.value('webPort') as number,
}
