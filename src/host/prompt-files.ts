// Prompt-file notices (task 48): the host polls every file in the prompt
// of each tab a client shows (every second) or a turn runs in (every
// half second): SYSTEM.md and its includes, and the AGENTS.md /
// CLAUDE.md files for its cwd. A change shows as a notice popup, never
// in scrollback, to clients showing a tab whose prompt it is in:
// SYSTEM.md reaches all of them. Each save stacks as its own notice for
// its full time. A file first seen is only remembered, so opening a tab
// announces nothing. Idle tabs nobody shows cost nothing.
import { readFileSync, statSync } from 'fs'
import { basename } from 'path'
import type { NoticeEvent } from '../common/notices.ts'
import { states } from '../common/states.ts'
import { diag } from './diag.ts'
import { pages } from './pages.ts'
import { paths } from './paths.ts'
import { plugins } from './plugins.ts'
import { promptTrail } from './prompt-trail.ts'
import { promptCache } from './prompt-cache.ts'
import { sessions } from './sessions.ts'
import { status } from './status.ts'
import { systemPrompt } from './system-prompt.ts'
import { tabs } from './tabs.ts'
import { projectContext } from './project-context.ts'

// `shown`: the tab a client shows even while its window lacks focus, so
// a notice waits on screen for the user coming back from the editor.
type Watcher = { deliver: (event: any) => void; visible?: string; shown?: string }

// A tab's prompt files, valid while `key` (its prompt input) holds.
// `size`: its history size when `interactive` was read from it.
type Tab = { key: string; files: Set<string>; size: number; interactive: boolean }

function read(path: string): string | null {
	try {
		return readFileSync(path, 'utf8')
	} catch (e: any) {
		if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
		throw e
	}
}

// Changes when the file is written or replaced; '' when it is missing.
// Writing the same size within one mtime tick, or forging the mtime,
// goes unseen.
function stamp(path: string): string {
	try {
		let s = statSync(path, { throwIfNoEntry: false })
		return s ? `${s.mtimeMs} ${s.size} ${s.ino}` : ''
	} catch (e: any) {
		if (e.code === 'ENOTDIR') return ''
		throw e
	}
}

function shownTab(c: Watcher): string | undefined {
	return c.shown ?? c.visible
}

// Every file in a session's prompt: SYSTEM.md, the files it includes
// (which bust the cache like SYSTEM.md itself) and the AGENTS.md /
// CLAUDE.md candidates for its cwd, present or not. Rebuilds the prompt
// only when its input changed; file edits drop the entry (check).
function files(id: string): Set<string> {
	let tab = promptFiles.state.tabs.get(id)
	let size = pages.marks(id).size
	let interactive = tab?.size === size ? tab.interactive : promptCache.interactive(id)
	let input = promptCache.input(id, { interactive })
	let meta = sessions.open(id)
	let dirs = systemPrompt.candidates(meta.cwd)
	let allowed = projectContext.allowed(meta.cwd, meta.projectTrust)
	let key = JSON.stringify([{ ...input, now: 0 }, dirs, allowed])
	if (tab?.key === key) {
		tab.size = size
		return tab.files
	}
	let local = allowed ? dirs.flatMap((d) => ['AGENTS.md', 'CLAUDE.md'].map((n) => `${d === '/' ? '' : d}/${n}`)) : []
	let used: string[] = [systemPrompt.file()]
	try {
		used = systemPrompt.inspect(input).sources.map((s) => s.path)
	} catch {}
	let result = new Set([...used, ...local])
	promptFiles.state.tabs.set(id, { key, files: result, size, interactive })
	return result
}

// Tabs to poll: those clients show on every `shown` pass, and those a
// turn runs in.
function polled(clients: Iterable<Watcher>, shown: boolean): Set<string> {
	let ids = new Set<string>()
	for (let [id, s] of status.state.states) if (states.busy(s)) ids.add(id)
	if (shown)
		for (let c of clients) {
			let id = shownTab(c)
			if (id) ids.add(id)
		}
	return ids
}

// One pass over `ids` (default: the shown tabs): compares each file in
// their prompts with what was last seen; reads only files whose stamp
// changed.
function check(clients: Iterable<Watcher>, ids?: Set<string>): void {
	let st = promptFiles.state
	let watching = [...clients].filter(shownTab)
	let shown = new Set(watching.map((c) => shownTab(c)!))
	ids ??= shown
	for (let id of st.tabs.keys()) if (!ids.has(id) && !shown.has(id)) st.tabs.delete(id)
	// A plugin hooking or unhooking the prompt changes it like a file.
	let hooks = plugins.state.patches.get(systemPrompt)?.get('assemble')?.run
	let changed = hooks !== st.hooks
	if (changed) st.tabs.clear()
	st.hooks = hooks
	let applies = new Map<string, Set<string>>()
	for (let id of ids) {
		try {
			applies.set(id, promptFiles.files(id))
		} catch (e: any) {
			diag.log(`prompt files: ${id}: ${e?.message ?? e}`)
			applies.set(id, new Set([systemPrompt.file()]))
		}
	}
	// A shown tab skipped this pass still hears of files it uses.
	let uses = (c: Watcher, path: string) => {
		let id = shownTab(c)!
		return (applies.get(id) ?? st.tabs.get(id)?.files)?.has(path)
	}
	let seen = st.seen
	for (let path of new Set([...applies.values()].flatMap((s) => [...s]))) {
		let mark = stamp(path)
		if (seen.has(path) && st.stamps.get(path) === mark) continue
		st.stamps.set(path, mark)
		let text = read(path)
		if (!seen.has(path)) {
			seen.set(path, text)
			continue
		}
		let before = seen.get(path)
		if (before === text) continue
		seen.set(path, text)
		changed = true
		// An edit may change the includes: rebuild those prompts.
		for (let [id, files] of applies) if (files.has(path)) st.tabs.delete(id)
		let what = before === null ? 'created' : text === null ? 'deleted' : 'changed'
		let to = watching.filter((c) => uses(c, path))
		// Each change stacks as its own notice for its full time.
		let seq = ++st.seq
		diag.log(`prompt files: ${path} ${what}; told ${to.map(shownTab).join(', ')}`)
		for (let c of to) {
			let notice: NoticeEvent = {
				type: 'notice',
				session: shownTab(c)!,
				name: basename(path),
				kind: 'update',
				what,
				line: paths.display(path),
				key: `prompt-file:${path}:${seq}`,
			}
			try {
				c.deliver(notice)
			} catch (e: any) {
				diag.log(`prompt files: deliver: ${e?.message ?? e}`)
			}
		}
	}
	// The transcript note (task ar); each open tab records only what
	// concerns it.
	if (changed) for (let id of tabs.file().open) promptTrail.check(id)
}

function start(clients: Iterable<Watcher>): void {
	if (promptFiles.state.timer) return
	// Edits made while the host was down: noted at once, in slices of
	// sliceMs so many open tabs never block the event loop (task 7j).
	void promptFiles.catchUp(tabs.file().open)
	let tick = () => {
		try {
			let shown = ++promptFiles.state.ticks % 2 === 0
			promptFiles.check(clients, promptFiles.polled(clients, shown))
		} catch (e: any) {
			diag.log(`prompt files: ${e?.message ?? e}`)
		}
	}
	promptFiles.state.timer = setInterval(tick, promptFiles.intervalMs)
	promptFiles.state.timer.unref?.()
}

async function catchUp(ids: string[]): Promise<void> {
	let end = performance.now() + promptFiles.sliceMs
	for (let id of ids) {
		if (performance.now() > end) {
			await new Promise((r) => setImmediate(r))
			if (!promptFiles.state.timer) return
			end = performance.now() + promptFiles.sliceMs
		}
		promptTrail.check(id)
	}
}

function stop(): void {
	clearInterval(promptFiles.state.timer)
	promptFiles.state = fresh()
}

function fresh() {
	return {
		seen: new Map<string, string | null>(),
		stamps: new Map<string, string>(),
		tabs: new Map<string, Tab>(),
		timer: undefined as ReturnType<typeof setInterval> | undefined,
		ticks: 0,
		seq: 0,
		hooks: undefined as unknown,
	}
}

export const promptFiles = {
	state: fresh(),
	// Working tabs every tick, shown tabs every other.
	intervalMs: 500,
	sliceMs: 4,
	files,
	polled,
	check,
	start,
	catchUp,
	stop,
}
