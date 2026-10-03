// Opt-in client diagnostics (task 4k). A local plugin calls start(path); nothing
// imports or enables this on the normal path. Only geometry and fixed
// cause labels are recorded, never frame strings or host/client identity.
import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from 'fs'
import { app } from './app.ts'
import { ansi } from './ansi.ts'
import { render } from './render.ts'
import { terminal } from './terminal.ts'

type Fn = (...args: any[]) => any
interface TraceState {
	fd: number | undefined
	count: number
	context: string[]
	pending: Set<string>
	painting: string[]
	undo: (() => void)[]
	error: string | undefined
}

function createState(): TraceState {
	return { fd: undefined, count: 0, context: [], pending: new Set(), painting: [], undo: [], error: undefined }
}

// Restore only our own replacements: another override must not be lost.
function hook<T extends object, K extends keyof T>(obj: T, key: K, around: (next: Fn, ...args: any[]) => any): void {
	let original = obj[key] as Fn
	let wrapper = (...args: any[]) => around(original, ...args)
	obj[key] = wrapper as T[K]
	redrawTrace.state.undo.push(() => {
		if (obj[key] === wrapper) obj[key] = original as T[K]
	})
}

function cause<T extends object, K extends keyof T>(obj: T, key: K, label: string): void {
	redrawTrace.hook(obj, key, (next, ...args) => {
		let st = redrawTrace.state
		st.context.push(label)
		try {
			return next(...args)
		} finally {
			st.context.pop()
		}
	})
}

function record(facts: Record<string, unknown>): void {
	let st = redrawTrace.state
	if (st.fd === undefined) return
	try {
		let bytes = Buffer.from(JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...facts }) + '\n')
		for (let at = 0; at < bytes.length; ) {
			let n = writeSync(st.fd, bytes, at)
			if (!n) throw new Error('trace write made no progress')
			at += n
		}
		if (++st.count >= redrawTrace.maxRecords) redrawTrace.stop()
	} catch (e) {
		st.error = String(e)
		redrawTrace.stop()
	}
}

function stop(): void {
	let st = redrawTrace.state
	for (let undo of st.undo.splice(0).reverse()) undo()
	if (st.fd !== undefined) {
		let fd = st.fd
		st.fd = undefined
		try { closeSync(fd) } catch (e) { st.error = String(e) }
	}
	st.pending.clear()
}

function start(path: string | URL): void {
	redrawTrace.stop()
	// Do not truncate a previous capture or follow a substituted symlink.
	let fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
	try {
		let stat = fstatSync(fd)
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()) throw new Error('trace requires a privately owned regular file with one link')
		fchmodSync(fd, 0o600)
	} catch (e) {
		closeSync(fd)
		throw e
	}
	redrawTrace.state = createState()
	redrawTrace.state.fd = fd
	// Event types are deliberately not copied from the payload: select the
	// useful protocol categories, with a fixed fallback for everything else.
	redrawTrace.hook(app, 'onEvent', (next, event) => {
		let type = ['stream', 'tool-output', 'tool-results', 'turn-start', 'turn-end', 'turn-stats', 'snapshot', 'history', 'tabs', 'state', 'draft', 'inbox', 'notice', 'auth', 'output', 'prompt', 'meta', 'question', 'answer', 'warning'].includes(event.type) ? event.type : 'other'
		let st = redrawTrace.state
		st.context.push(`event:${type}`)
		try { return next(event) } finally { st.context.pop() }
	})
	for (let key of ['beat', 'onKeys', 'onState', 'onTabs'] as const) redrawTrace.cause(app, key, `app.${key}`)
	redrawTrace.cause(terminal, 'resized', 'terminal.resized')
	// Plugins activate before render.init(), which installs these callbacks.
	let terminalHooked = false
	let hookTerminal = () => {
		if (terminalHooked || !render.state.out) return
		terminalHooked = true
		for (let key of ['redraw', 'onResize'] as const) redrawTrace.cause(terminal, key, `terminal.${key}`)
	}
	redrawTrace.hook(render, 'init', (next, ...args) => {
		let result = next(...args)
		hookTerminal()
		return result
	})
	hookTerminal()
	redrawTrace.hook(render, 'request', (next) => {
		let st = redrawTrace.state
		for (let label of st.context.length ? st.context : ['render.request']) st.pending.add(label)
		return next()
	})
	redrawTrace.hook(render, 'draw', (next, force = false) => {
		let st = redrawTrace.state
		let before = st.painting
		st.painting = [...new Set([...st.pending, ...st.context])]
		if (!st.painting.length) st.painting.push('render.draw')
		st.pending.clear()
		try { return next(force) } finally { st.painting = before }
	})
	redrawTrace.hook(render, 'paintParts', (next, frame, rows, force = false) => {
		let prev = render.state.prev
		let oldRows = prev.length, newRows = frame.lines.length
		let first = 0
		while (first < oldRows && first < newRows && prev[first] === frame.lines[first]) first++
		let same = first === oldRows && first === newRows
		while (first > 0 && first < newRows && frame.lines[first - 1].endsWith(ansi.FLOW)) first--
		let writableTop = Math.max(0, oldRows - rows)
		let wasFull = render.state.fullscreen
		let oldCursorRow = render.state.cursorRow
		let parts = next(frame, rows, force) as (string | (() => string))[]
		let clear = parts.some((p) => typeof p === 'string' && p.includes('\x1b[3J'))
		let home = parts.some((p) => typeof p === 'string' && p.includes('\x1b[H'))
		let reason = clear ? force ? 'forced' : newRows < oldRows ? 'shrink' : first < writableTop ? 'immutable-row-changed' : 'rebuild' : same ? 'unchanged' : 'diff'
		redrawTrace.record({
			causes: redrawTrace.state.painting.length ? redrawTrace.state.painting : [...redrawTrace.state.context, 'render.paintParts'],
			reason, force, wasFull, fullscreen: render.state.fullscreen, rows, oldRows, newRows,
			firstChanged: same ? null : first, writableTop, oldCursorRow,
			cursorRow: frame.cursor.row, cursorCol: frame.cursor.col, clear, home,
			inlineBytes: parts.reduce((n, p) => n + (typeof p === 'string' ? Buffer.byteLength(p) : 0), 0),
			deferredParts: parts.filter((p) => typeof p === 'function').length,
		})
		return parts
	})
}

export const redrawTrace = {
	state: createState(),
	/** A bounded diagnostic run; start again explicitly for another capture. */
	maxRecords: 20000,
	start, stop, hook, cause, record,
}
