// Prompt-file notices (task 48): while clients watch tabs, the
// host checks every file in each watched tab's prompt: SYSTEM.md and
// its includes, and the AGENTS.md / CLAUDE.md files for its cwd. A
// change shows as a notice popup, never in scrollback, to clients
// showing a tab whose prompt it is in: SYSTEM.md reaches all of them.
// Keyed by path, so repeated saves replace one notice. A file first
// seen is only remembered, so opening a tab announces nothing.
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { NoticeEvent } from '../common/notices.ts'
import { diag } from './diag.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { systemPrompt } from './system-prompt.ts'

type Watcher = { deliver: (event: any) => void; visible?: string }

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
	try { used = systemPrompt.inspect({ cwd: meta.cwd, model: meta.model ?? '', now: Date.now(), sessionId: id }).sources.map((s) => s.path) } catch {}
	return new Set([...used, ...local])
}

// One pass: compares each relevant file with what was last seen.
function check(clients: Iterable<Watcher>): void {
	let watching = [...clients].filter((c) => c.visible)
	if (!watching.length) return
	let applies = new Map<Watcher, Set<string>>()
	for (let c of watching) {
		try { applies.set(c, promptFiles.files(c.visible!)) } catch (e: any) {
			diag.log(`prompt files: ${c.visible}: ${e?.message ?? e}`)
			applies.set(c, new Set([systemPrompt.file()]))
		}
	}
	let seen = promptFiles.state.seen
	for (let path of new Set([...applies.values()].flatMap((s) => [...s]))) {
		let text = read(path)
		if (!seen.has(path)) { seen.set(path, text); continue }
		let before = seen.get(path)
		if (before === text) continue
		seen.set(path, text)
		let what = before === null ? 'created' : text === null ? 'deleted' : 'changed'
		let to = watching.filter((c) => applies.get(c)!.has(path))
		diag.log(`prompt files: ${path} ${what}; told ${to.map((c) => c.visible).join(', ')}`)
		for (let c of to) {
			let notice: NoticeEvent = { type: 'notice', session: c.visible!, name: basename(path), kind: 'update', what, line: paths.display(path), key: `prompt-file:${path}` }
			try { c.deliver(notice) } catch (e: any) { diag.log(`prompt files: deliver: ${e?.message ?? e}`) }
		}
	}
}

function start(clients: Iterable<Watcher>): void {
	if (promptFiles.state.timer) return
	promptFiles.state.timer = setInterval(() => {
		try { promptFiles.check(clients) } catch (e: any) { diag.log(`prompt files: ${e?.message ?? e}`) }
	}, promptFiles.intervalMs())
	promptFiles.state.timer.unref?.()
}

function stop(): void {
	clearInterval(promptFiles.state.timer)
	promptFiles.state = { seen: new Map(), timer: undefined }
}

export const promptFiles = {
	state: { seen: new Map<string, string | null>(), timer: undefined as ReturnType<typeof setInterval> | undefined },
	intervalMs: (): number => 1000,
	files, check, start, stop,
}
