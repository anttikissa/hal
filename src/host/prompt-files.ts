// Prompt-file notices (task 48): while clients watch tabs, the
// host checks every file in each watched tab's prompt: SYSTEM.md and
// its includes, and the AGENTS.md / CLAUDE.md files for its cwd. A
// change shows as a notice popup, never in scrollback, to clients
// showing a tab whose prompt it is in: SYSTEM.md reaches all of them.
// Each save stacks as its own notice for its full time. A file first
// seen is only remembered, so opening a tab announces nothing.
import { readFileSync, watch, type FSWatcher } from 'fs'
import { basename, dirname } from 'path'
import type { NoticeEvent } from '../common/notices.ts'
import { diag } from './diag.ts'
import { paths } from './paths.ts'
import { plugins } from './plugins.ts'
import { promptTrail } from './prompt-trail.ts'
import { promptCache } from './prompt-cache.ts'
import { sessions } from './sessions.ts'
import { systemPrompt } from './system-prompt.ts'
import { tabs } from './tabs.ts'

// `shown`: the tab a client shows even while its window lacks focus, so
// a notice waits on screen for the user coming back from the editor.
type Watcher = { deliver: (event: any) => void; visible?: string; shown?: string }

function read(path: string): string | null {
	try { return readFileSync(path, 'utf8') } catch (e: any) {
		if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
		throw e
	}
}

// Every file in a session's prompt: SYSTEM.md, the files it includes
// (which bust the cache like SYSTEM.md itself) and the AGENTS.md /
// CLAUDE.md candidates for its cwd, present or not.
function files(id: string): Set<string> {
	let meta = sessions.open(id)
	let local = systemPrompt.candidates(meta.cwd).flatMap((d) => ['AGENTS.md', 'CLAUDE.md'].map((n) => `${d === '/' ? '' : d}/${n}`))
	let used: string[] = [systemPrompt.file()]
	try { used = systemPrompt.inspect(promptCache.input(id)).sources.map((s) => s.path) } catch {}
	return new Set([...used, ...local])
}

// One pass: compares each relevant file with what was last seen.
function check(clients: Iterable<Watcher>): void {
	let watching = [...clients].filter((c) => c.shown ?? c.visible)
	if (!watching.length) return promptFiles.watchDirs(new Set())
	let applies = new Map<Watcher, Set<string>>()
	for (let c of watching) {
		try { applies.set(c, promptFiles.files((c.shown ?? c.visible)!)) } catch (e: any) {
			diag.log(`prompt files: ${c.shown ?? c.visible}: ${e?.message ?? e}`)
			applies.set(c, new Set([systemPrompt.file()]))
		}
	}
	let seen = promptFiles.state.seen
	let all = new Set([...applies.values()].flatMap((s) => [...s]))
	promptFiles.watchDirs(new Set([...all].map((p) => dirname(p))))
	// A plugin hooking or unhooking the prompt changes it like a file.
	let hooks = plugins.state.patches.get(systemPrompt)?.get('assemble')?.run
	let changed = hooks !== promptFiles.state.hooks
	promptFiles.state.hooks = hooks
	for (let path of all) {
		let text = read(path)
		if (!seen.has(path)) { seen.set(path, text); continue }
		let before = seen.get(path)
		if (before === text) continue
		seen.set(path, text)
		changed = true
		let what = before === null ? 'created' : text === null ? 'deleted' : 'changed'
		let to = watching.filter((c) => applies.get(c)!.has(path))
		// Each change stacks as its own notice for its full time.
		let seq = ++promptFiles.state.seq
		diag.log(`prompt files: ${path} ${what}; told ${to.map((c) => c.shown ?? c.visible).join(', ')}`)
		for (let c of to) {
			let notice: NoticeEvent = { type: 'notice', session: (c.shown ?? c.visible)!, name: basename(path), kind: 'update', what, line: paths.display(path), key: `prompt-file:${path}:${seq}` }
			try { c.deliver(notice) } catch (e: any) { diag.log(`prompt files: deliver: ${e?.message ?? e}`) }
		}
	}
	// The transcript note (task ar); each open tab records only what
	// concerns it.
	if (changed) for (let id of tabs.file().open) promptTrail.check(id)
}

// Directory watchers make a save show at once; the poll still catches
// tab and cwd changes and filesystems without events. Directories, as
// editors save by rename.
function watchDirs(dirs: Set<string>): void {
	let w = promptFiles.state.watchers
	for (let [dir, watcher] of w) if (!dirs.has(dir)) { watcher.close(); w.delete(dir) }
	for (let dir of dirs) {
		if (w.has(dir)) continue
		try {
			w.set(dir, watch(dir, { persistent: false }, (_e, name) => {
				if (name && !promptFiles.state.seen.has(`${dir === '/' ? '' : dir}/${name}`)) return
				clearTimeout(promptFiles.state.soon)
				promptFiles.state.soon = setTimeout(() => promptFiles.state.tick?.(), 30)
			}))
		} catch {}
	}
}

function start(clients: Iterable<Watcher>): void {
	if (promptFiles.state.timer) return
	// Edits made while the host was down: noted at once, in slices of
	// sliceMs so many open tabs never block the event loop (task 7j).
	void promptFiles.catchUp(tabs.file().open)
	promptFiles.state.tick = () => {
		try { promptFiles.check(clients) } catch (e: any) { diag.log(`prompt files: ${e?.message ?? e}`) }
	}
	promptFiles.state.timer = setInterval(() => promptFiles.state.tick?.(), promptFiles.intervalMs)
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
	clearTimeout(promptFiles.state.soon)
	for (let w of promptFiles.state.watchers.values()) w.close()
	promptFiles.state = { seen: new Map(), timer: undefined, soon: undefined, tick: undefined, watchers: new Map(), seq: 0, hooks: undefined }
}

export const promptFiles = {
	state: { seen: new Map<string, string | null>(), timer: undefined as ReturnType<typeof setInterval> | undefined, soon: undefined as ReturnType<typeof setTimeout> | undefined, tick: undefined as (() => void) | undefined, watchers: new Map<string, FSWatcher>(), seq: 0, hooks: undefined as unknown },
	intervalMs: 1000,
	sliceMs: 4,
	files, check, watchDirs, start, catchUp, stop,
}
