// Host startup facts and deliberate restart attribution (tasks 2e, nvm).
// One bounded live file holds the previous loaded version and the next
// deliberate cause. Startup saves and appends notices under the host lock,
// before listening or recovering turns. Local client restarts do nothing.
import { history } from './history.ts'
import { host } from './host.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { tabs } from './tabs.ts'

const freshMs = 60_000
const state = { written: false, text: undefined as string | undefined, until: 0, errors: [] as string[] }
type Stamp = { text?: string; at?: number; loaded?: string }

function file(): string {
	return `${paths.stateDir()}/restart.ason`
}

function read(): Stamp {
	let data = liveFiles.liveFile<Stamp>(restartNote.file(), {}, { watch: false, mode: 0o600 })
	if ((data.text !== undefined && typeof data.text !== 'string') || (data.at !== undefined && (typeof data.at !== 'number' || !Number.isFinite(data.at))) || (data.loaded !== undefined && typeof data.loaded !== 'string')) {
		liveFiles.close(data)
		throw new Error(`${restartNote.file()}: invalid restart state`)
	}
	return data
}

// First writer wins: /restart host also exits through Ctrl-R's path.
// Emergency restart must still work when the disk is full; show the full
// write failure on stderr instead of silently losing attribution.
function write(text: string): void {
	if (state.written) return
	state.written = true
	try {
		let data = restartNote.read()
		try {
			data.text = text
			data.at = Date.now()
			liveFiles.save(data)
		} finally {
			liveFiles.close(data)
		}
	} catch (error) {
		process.stderr.write(`${restartNote.file()}: ${String(error)}\n`)
	}
}

// Called once on acquiring the host lock, before accepting requests.
// Existing open tabs are restored explicitly, not all sessions on disk.
function started(loaded: string): void {
	let data = restartNote.read()
	try {
		let previous = data.loaded
		let by = data.text && data.at !== undefined && Date.now() - data.at <= freshMs ? data.text : undefined
		let ids = tabs.file().open
		let restarted = previous !== undefined || by !== undefined || ids.length > 0
		data.loaded = loaded
		delete data.text
		delete data.at
		liveFiles.save(data)
		if (!restarted) return
		let text = `${by ? `Hal restarted by ${by}` : 'A new Hal host started; restart cause unknown'}. Loaded version: ${loaded}${previous !== undefined ? ` (previous host: ${previous})` : ' (previous host version unknown)'}.`
		state.text = text
		state.until = Date.now() + freshMs
		for (let client of host.state.clients) client.deliver({ type: 'warning', text })
		let warn = host.warn
		host.warn = (client) => {
			warn(client)
			let pending = restartNote.pending()
			if (pending) client.deliver({ type: 'warning', text: pending })
			for (let error of state.errors) client.deliver({ type: 'warning', text: error })
		}
		state.errors = []
		for (let id of ids) {
			try {
				sessions.open(id)
				history.append(id, { type: 'notice', text })
			} catch (error) {
				let message = `Restart notice for ${id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
				state.errors.push(message)
				process.stderr.write(message + '\n')
				for (let client of host.state.clients) client.deliver({ type: 'warning', text: message })
			}
		}
	} finally {
		liveFiles.close(data)
	}
}

// Existing client warning UI, also for clients joining within a minute.
function pending(): string | undefined {
	return state.text && Date.now() < state.until ? state.text : undefined
}

export const restartNote = { state, file, read, write, started, pending }
