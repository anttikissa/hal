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
	| { kind: 'secret' }
	| { kind: 'integer'; min: number; max: number }
	| { kind: 'choice'; options: string[] }
	| { kind: 'boolean' }

// `browser`: the web page needs it too, so the host writes it into the
// page it serves (host/web.ts); the page reads it with settings.load.
export type Setting = { name: string; type: SettingType; default: unknown; description: string; browser?: true }

const table: Setting[] = [
	{ name: 'model', type: { kind: 'text' }, default: 'anthropic/claude-opus-5-5', description: 'Default model (provider/id or alias, optional :effort or :default) for new sessions.' },
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
	{ name: 'webPort', type: { kind: 'integer', min: 1, max: 65535 }, default: 9001, description: 'Preferred port for the browser client (127.0.0.1); tries through 9100 if busy.' },
	{
		name: 'webUrl',
		type: { kind: 'text', url: true },
		default: '',
		description: 'Public address of the browser client, such as https://hal.example.com; empty means http://localhost:<webPort>.',
	},
	{ name: 'sessionRecap', type: { kind: 'boolean' }, default: false, description: 'Show a short session recap when returning to a tab idle for 24 hours (/recap always works).' },
	{ name: 'push', type: { kind: 'boolean' }, default: true, description: 'Send web push notifications to subscribed devices.' },
	{
		name: 'webDiagnostics',
		type: { kind: 'boolean' },
		default: false,
		description: "Web pages report structural diagnostics (no text) to this host's state/web-diag.log.",
		browser: true,
	},
]

// Why `value` doesn't fit `type`, or undefined if it does.
function problem(type: SettingType, value: unknown): string | undefined {
	switch (type.kind) {
		case 'secret':
			return typeof value === 'string' && value !== '' ? undefined : 'expected a non-empty string'
		case 'text':
			// An empty address means the default (localhost).
			if (typeof value !== 'string' || (value === '' && !type.url)) return 'expected a non-empty string'
			if (value === '') return undefined
			return !type.url || /^https?:\/\/[^\s\p{Cc}/?#]+(\/[^\s\p{Cc}?#]*)?$/u.test(value) ? undefined : 'expected an http(s) address without ? or #'
		case 'integer':
			return Number.isInteger(value) && (value as number) >= type.min && (value as number) <= type.max
				? undefined
				: `expected an integer ${type.min}–${type.max}`
		case 'choice':
			return type.options.includes(value as string) ? undefined : `expected one of ${type.options.map((o) => `'${o}'`).join(', ')}`
		case 'boolean':
			return typeof value === 'boolean' ? undefined : 'expected true or false'
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
		let why = settings.problem(s.type, raw[s.name])
		if (!why) values[s.name] = raw[s.name]
		else warnings.push(`${s.name}: ${why}${s.type.kind === 'secret' ? '' : `, got ${JSON.stringify(raw[s.name]) ?? String(raw[s.name])}`}; using the default`)
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
	state: { raw: {} as Record<string, unknown>, listeningPort: undefined as number | undefined },
	table,
	check,
	problem,
	value,
	forPage,
	load,
	warnings: (): string[] => settings.check(settings.state.raw).warnings,
	model: (): string => settings.value('model') as string,
	security: (): 'best-effort' | 'none' => settings.value('security') as 'best-effort' | 'none',
	webPort: (): number => settings.value('webPort') as number,
	// Where web links point, without a trailing slash (task e3).
	webUrl: (): string => ((settings.value('webUrl') as string) || `http://localhost:${settings.state.listeningPort ?? settings.webPort()}`).replace(/\/+$/, ''),
	promptRows: (): number => settings.value('promptRows') as number,
	pasteLines: (): number => settings.value('pasteLines') as number,
	maxRounds: (): number => settings.value('maxRounds') as number,
	sessionRecap: (): boolean => settings.value('sessionRecap') as boolean,
	push: (): boolean => settings.value('push') as boolean,
	webDiagnostics: (): boolean => settings.value('webDiagnostics') as boolean,
}
