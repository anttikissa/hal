// Deliberate restart attribution (2e) and model notices (nvm).
import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

let written = false

// First writer wins: /restart also exits through the terminal's path.
function write(text: string): void {
	if (written) return
	written = true
	try { writeFileSync(`${paths.stateDir()}/restart.ason`, ason.stringify({ text, at: Date.now() }) + '\n') } catch {}
}

function announce(): void {
	let text: string | undefined, until = Date.now() + 60_000
	try {
		let file = `${paths.stateDir()}/restart.ason`
		let note = ason.parse(readFileSync(file, 'utf8')) as { text?: unknown; at?: unknown }
		unlinkSync(file)
		if (typeof note.text === 'string' && typeof note.at === 'number' && Date.now() - note.at <= 60_000) text = `Hal restarted by ${note.text}`
	} catch {}
	if (text) {
		let warn = host.warn
		host.warn = (client) => {
			warn(client)
			if (Date.now() < until) client.deliver({ type: 'warning', text })
		}
		for (let client of host.state.clients) client.deliver({ type: 'warning', text })
	}
	for (let id of tabs.file().open) {
		try {
			sessions.open(id)
			history.append(id, { type: 'notice', text: text ?? 'Hal restarted; cause unknown (crash, kill or quit)' })
		} catch (e) { process.stderr.write(`restart notice for ${id}: ${e instanceof Error ? e.stack : e}\n`) }
	}
}

export const restartNote = { write, announce }
