// config.ason: the common settings (declared in src/common/settings.ts)
// as a live file in the home root. User-edited like a dotfile; edits
// apply at once. It never stops Hal: a missing file means defaults, and
// a malformed file, bad value or unknown key is a warning (host.ts shows
// it to every client) while that setting keeps its default.

import { settings } from '../common/settings.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

// Loads and watches config.ason; `onChange` hears every external edit.
// Idempotent.
function init(onChange?: () => void): void {
	if (config.state.data) return
	let data = liveFiles.liveFile<Record<string, unknown>>(paths.configFile(), {}, { keepBroken: true, onChange: () => onChange?.() })
	config.state.data = data
	settings.state.raw = data
}

// What is wrong with the file right now, one line each.
function warnings(): string[] {
	let data = config.state.data
	if (!data) return []
	let broken = liveFiles.brokenError(data)
	if (broken) return [`${paths.display(broken.message)}; using the last good settings`]
	return settings.warnings().map((w) => `config.ason: ${w}`)
}

// Stops watching and forgets the file (tests).
function reset(): void {
	let data = config.state.data
	config.state.data = null
	settings.state.raw = {}
	if (data) liveFiles.close(data)
}

export const config = {
	state: { data: null as Record<string, unknown> | null },
	init,
	warnings,
	reset,
}
