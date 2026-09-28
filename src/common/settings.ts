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
	| { kind: 'text'; url?: true }
	| { kind: 'integer'; min: number; max: number }
	| { kind: 'number'; min: number; max: number }
	| { kind: 'choice'; options: string[] }

// `browser`: the web page needs it too, so the host writes it into the
// page it serves (host/web.ts); the page reads it with settings.load.
export type Setting = { name: string; type: SettingType; default: unknown; description: string; browser?: true }

const table: Setting[] = [
	{ name: 'model', type: { kind: 'text' }, default: 'anthropic/claude-opus-5-5', description: 'Default model (provider/id) for new sessions.' },
	{
		name: 'security',
		type: { kind: 'choice', options: ['best-effort', 'none'] },
		default: 'best-effort',
		description: 'Ask before tool calls matching dangerous patterns (best-effort), or never (none).',
	},
	{
		name: 'promptRows',
		type: { kind: 'integer', min: 1, max: 100 },
		default: 10,
		description: 'Rows the terminal prompt box shows before it scrolls.',
		browser: true,
	},
	{
		name: 'pasteLines',
		type: { kind: 'integer', min: 1, max: 10000 },
		default: 7,
		description: 'Pasted text longer than this many lines becomes an attachment.',
		browser: true,
	},
	{
		name: 'maxRounds',
		type: { kind: 'integer', min: 1, max: 100000 },
		default: 200,
		description: 'Provider rounds one turn may run before it pauses; Enter continues for as many again.',
	},
	{
		name: 'compactAt',
		type: { kind: 'number', min: 0, max: 1 },
		default: 0.85,
		description: 'Compact the context when the last request filled this fraction of the model window; 0 never does.',
	},
	{ name: 'webPort', type: { kind: 'integer', min: 1, max: 65535 }, default: 9002, description: 'Port for the browser client (127.0.0.1).' },
	{
		name: 'webUrl',
		type: { kind: 'text', url: true },
		default: '',
		description: 'Public address of the browser client, such as https://hal.example.com; empty means http://localhost:<webPort>.',
	},
]

// Why `value` doesn't fit `type`, or undefined if it does.
function problem(type: SettingType, value: unknown): string | undefined {
	switch (type.kind) {
		case 'text':
			// An empty address means the default (localhost).
			if (typeof value !== 'string' || (value === '' && !type.url)) return 'expected a non-empty string'
			if (value === '') return undefined
			return !type.url || /^https?:\/\/[^\s\p{Cc}/?#]+(\/[^\s\p{Cc}?#]*)?$/u.test(value) ? undefined : 'expected an http(s) address without ? or #'
		case 'integer':
			return Number.isInteger(value) && (value as number) >= type.min && (value as number) <= type.max
				? undefined
				: `expected an integer ${type.min}–${type.max}`
		case 'number':
			return typeof value === 'number' && value >= type.min && value <= type.max ? undefined : `expected a number ${type.min}–${type.max}`
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
		else warnings.push(`${s.name}: ${why}, got ${JSON.stringify(raw[s.name]) ?? String(raw[s.name])}; using the default`)
	}
	for (let key of Object.keys(raw)) {
		if (!settings.table.some((s) => s.name === key)) warnings.push(`unknown setting '${key}', ignored`)
	}
	return { values, warnings }
}

function value(name: string): unknown {
	return settings.check(settings.state.raw).values[name]
}

// The effective values of the settings marked `browser`, as the JSON the
// host puts in the page, with < escaped so it cannot end the script.
function forPage(): string {
	let values = settings.check(settings.state.raw).values
	let out = Object.fromEntries(settings.table.filter((s) => s.browser).map((s) => [s.name, values[s.name]]))
	return JSON.stringify(out).replaceAll('<', '\\u003c')
}

// The page's side of forPage: `json` becomes the raw settings, checked
// like config.ason; unreadable JSON means defaults.
function load(json: string | null | undefined): void {
	let raw: unknown
	try {
		raw = JSON.parse(json || '{}')
	} catch {
		raw = {}
	}
	settings.state.raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

export const settings = {
	// The parsed config file (a live object on the host); {} means defaults.
	state: { raw: {} as Record<string, unknown> },
	table,
	check,
	value,
	forPage,
	load,
	warnings: (): string[] => settings.check(settings.state.raw).warnings,
	model: (): string => settings.value('model') as string,
	security: (): 'best-effort' | 'none' => settings.value('security') as 'best-effort' | 'none',
	webPort: (): number => settings.value('webPort') as number,
	// Where web links point, without a trailing slash (task e3).
	webUrl: (): string => ((settings.value('webUrl') as string) || `http://localhost:${settings.webPort()}`).replace(/\/+$/, ''),
	promptRows: (): number => settings.value('promptRows') as number,
	pasteLines: (): number => settings.value('pasteLines') as number,
	maxRounds: (): number => settings.value('maxRounds') as number,
	compactAt: (): number => settings.value('compactAt') as number,
}
