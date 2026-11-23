// Tells users why Hal restarted and models that it did: a deliberate
// restart is attributed to its cause (task 2e), and sessions get a notice
// (task nvm). When a model ran /restart, its accepted turn identity rides
// along once so turn-recovery can resume that exact turn (task xbp).
import { readFileSync, unlinkSync, writeFileSync } from 'fs'
import { ason } from '../common/ason.ts'
import { history } from './history.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'
import { warnings } from './warnings.ts'

export type RestartInitiator = {
	sessionId: string
	origin: 'model'
	afterEnd: number
	commandN: number
}

type StoredNote = { text?: string; at?: number; initiator?: RestartInitiator }

let written = false
let loaded = false
let pendingNote: StoredNote | undefined
const modelText = 'Hal restarted.'

function parseInitiator(raw: unknown): RestartInitiator | undefined {
	if (!raw || typeof raw !== 'object') return undefined
	let x = raw as Record<string, unknown>
	if (
		typeof x.sessionId !== 'string' ||
		x.origin !== 'model' ||
		typeof x.afterEnd !== 'number' ||
		!Number.isInteger(x.afterEnd) ||
		x.afterEnd < 0 ||
		typeof x.commandN !== 'number' ||
		!Number.isInteger(x.commandN) ||
		x.commandN <= 0
	)
		return undefined
	return { sessionId: x.sessionId, origin: 'model', afterEnd: x.afterEnd, commandN: x.commandN }
}

// First writer wins: /restart also exits through the terminal's path.
function write(text: string, initiator?: RestartInitiator): void {
	if (written) return
	written = true
	try {
		writeFileSync(
			`${paths.stateDir()}/restart.ason`,
			ason.stringify({ text, at: Date.now(), ...(initiator && { initiator }) }) + '\n',
		)
	} catch {}
}

function load(): StoredNote | undefined {
	if (loaded) return pendingNote
	loaded = true
	try {
		let file = `${paths.stateDir()}/restart.ason`
		let note = ason.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
		unlinkSync(file)
		pendingNote = {
			...(typeof note.text === 'string' && { text: note.text }),
			...(typeof note.at === 'number' && { at: note.at }),
			...(parseInitiator(note.initiator) && { initiator: parseInitiator(note.initiator) }),
		}
	} catch {}
	return pendingNote
}

function takeInitiator(): RestartInitiator | undefined {
	let note = load()
	let initiator = note?.initiator
	if (note) delete note.initiator
	return initiator
}

function reset(): void {
	written = false
	loaded = false
	pendingNote = undefined
}

async function announce(): Promise<void> {
	let note = load()
	let text =
		note?.text && note.at !== undefined && Date.now() - note.at <= 60_000 ? `Hal restarted by ${note.text}` : undefined
	if (text) {
		warnings.set('restart', text)
		setTimeout(() => warnings.set('restart'), 60_000).unref?.()
	}
	// Models hear one line per idle stretch: no cause, no repeat while the
	// last one is unread, none for a turn turn-recovery continues (it says so).
	for (let id of tabs.file().open) {
		await new Promise((resolve) => setImmediate(resolve))
		try {
			sessions.open(id)
			let last = pages.findLast(id, () => true)
			if ((history.unfinished(id) && last?.type !== 'question') || (last?.type === 'notice' && last.text === modelText))
				continue
			history.append(id, { type: 'notice', text: modelText })
		} catch (e) {
			warnings.tell({ type: 'warning', text: `restart notice for ${id}: ${e instanceof Error ? e.stack : e}` })
		}
	}
}

export const restartNote = { write, announce, takeInitiator, reset }
