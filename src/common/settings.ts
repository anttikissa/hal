// Common settings: the one table of what config.ason (home root) may
// hold. The table validates the file, documents it, and is what /config
// lists, a row per setting (common/settings-modal.ts). Anything
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

// `label`: what /config shows for it (the name is config.ason's key).
// `browser`: the web page needs it too, so the host writes it into the
// page it serves (host/web.ts); the page reads it with settings.load.
export type Setting = { name: string; label: string; type: SettingType; default: unknown; description: string; browser?: true }

const table: Setting[] = [
	{ name: 'hostMode', label: 'Host mode', type: { kind: 'choice', options: ['auto', 'server'] }, default: 'auto', description: 'auto: local clients may become host. server: only hal serve hosts; local clients wait and reconnect. Changing this does not stop an existing host.' },
	{ name: 'subagentSlots', label: 'Spawn budget', type: { kind: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER }, default: 3, description: 'Spawn slots for new sessions. Each subagent costs one slot from its owner and every owner ancestor; /budget changes only the current session.', browser: true },
	{ name: 'model', label: 'Default model', type: { kind: 'text' }, default: 'anthropic/claude-opus-5-5', description: 'Default model (provider/id or alias, optional :effort) for new sessions. To switch only the current session, use Ctrl-M or /model.' },
	{
		name: 'security',
		label: 'Security',
		type: { kind: 'choice', options: ['best-effort', 'none'] },
		default: 'best-effort',
		description: 'Ask before tool calls matching dangerous patterns (best-effort), or never (none).',
	},
	{
		name: 'promptRows',
		label: 'Prompt rows',
		type: { kind: 'integer', min: 1, max: 100 },
		default: 10,
		description: 'Rows the terminal prompt box shows before it scrolls.',
		browser: true,
	},
	{
		name: 'pasteLines',
		label: 'Paste attachment threshold',
		type: { kind: 'integer', min: 1, max: 10000 },
		default: 7,
		description: 'Pasted text longer than this many lines becomes an attachment.',
		browser: true,
	},
	{
		name: 'maxRounds',
		label: 'Rounds per turn',
		type: { kind: 'integer', min: 1, max: 100000 },
		default: 200,
		description: 'Provider rounds one turn may run before it pauses; Enter continues for as many again.',
	},
	{ name: 'webPort', label: 'Web port', type: { kind: 'integer', min: 1, max: 65535 }, default: 9001, description: 'Preferred port for the browser client (127.0.0.1); tries through 9100 if busy.' },
	{
		name: 'webUrl',
		label: 'Web address',
		type: { kind: 'text', url: true },
		default: '',
		description: 'Public address of the browser client, such as https://hal.example.com; empty means http://localhost:<webPort>.',
	},
	{ name: 'sessionRecap', label: 'Session recap', type: { kind: 'boolean' }, default: false, description: 'Show a short session recap when returning to a tab idle for 24 hours (/recap always works).' },
	{ name: 'push', label: 'Push notifications', type: { kind: 'boolean' }, default: true, description: 'Send web push notifications to subscribed devices.' },
	{
		name: 'webDiagnostics',
		label: 'Web diagnostics',
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

// The value typed text stands for: /config <name> <value> and the
// modal's edits. Check the result with problem.
function fromText(type: SettingType, text: string): unknown {
	if (type.kind === 'integer') return /^-?\d+$/.test(text) ? Number(text) : NaN
	if (type.kind === 'boolean') return text === 'true' ? true : text === 'false' ? false : text
	return text
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
	fromText,
	value,
	forPage,
	load,
	warnings: (): string[] => settings.check(settings.state.raw).warnings,
	subagentSlots: (): number => settings.value('subagentSlots') as number,
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
