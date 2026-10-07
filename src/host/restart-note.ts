// Deliberate restart attribution (2e) and model notices (nvm).
import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { warnings } from './warnings.ts'

let written = false
const modelText = 'Hal restarted.'

// First writer wins: /restart also exits through the terminal's path.
function write(text: string): void {
	if (written) return
	written = true
	try { writeFileSync(`${paths.stateDir()}/restart.ason`, ason.stringify({ text, at: Date.now() }) + '\n') } catch {}
}

function announce(): void {
	let text: string | undefined
	try {
		let file = `${paths.stateDir()}/restart.ason`
		let note = ason.parse(readFileSync(file, 'utf8')) as { text?: unknown; at?: unknown }
		unlinkSync(file)
		if (typeof note.text === 'string' && typeof note.at === 'number' && Date.now() - note.at <= 60_000) text = `Hal restarted by ${note.text}`
	} catch {}
	if (text) {
		warnings.set('restart', text)
		setTimeout(() => warnings.set('restart'), 60_000).unref?.()
	}
	// Models hear one line per idle stretch: no cause, no repeat while the
	// last one is unread, none for a turn turn-recovery continues (it says so).
	for (let id of tabs.file().open) {
		try {
			sessions.open(id)
			let last = pages.page(id, undefined, 1).records.at(-1)
			if ((history.unfinished(id) && last?.type !== 'question') || (last?.type === 'notice' && last.text === modelText)) continue
			history.append(id, { type: 'notice', text: modelText })
		} catch (e) { process.stderr.write(`restart notice for ${id}: ${e instanceof Error ? e.stack : e}\n`) }
	}
}

export const restartNote = { write, announce }
