// Prompt-file notices (task 48): while clients watch tabs, the
// host checks SYSTEM.md and the AGENTS.md / CLAUDE.md files that apply
// to each watched tab's cwd (systemPrompt.candidates). A change shows
// as a notice popup, never in scrollback: SYSTEM.md to every watching
// client, an AGENTS.md only to clients showing a tab it applies to.
// Keyed by path, so repeated saves replace one notice. A file first
// seen is only remembered, so opening a tab announces nothing.
import { readFileSync } from 'fs'
import { basename } from 'path'
import type { NoticeEvent } from '../common/notices.ts'
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

// AGENTS.md and CLAUDE.md paths that apply to a session's cwd.
function local(id: string): string[] {
	return systemPrompt.candidates(sessions.open(id).cwd).flatMap((d) => ['AGENTS.md', 'CLAUDE.md'].map((n) => `${d === '/' ? '' : d}/${n}`))
}

// One pass: compares each relevant file with what was last seen.
function check(clients: Iterable<Watcher>): void {
	let watching = [...clients].filter((c) => c.visible)
	if (!watching.length) return
	let system = systemPrompt.file()
	let applies = new Map<Watcher, Set<string>>()
	for (let c of watching) {
		try { applies.set(c, new Set(promptFiles.local(c.visible!))) } catch { applies.set(c, new Set()) }
	}
	let files = new Set([system, ...[...applies.values()].flatMap((s) => [...s])])
	let seen = promptFiles.state.seen
	for (let path of files) {
		let text = read(path)
		if (!seen.has(path)) { seen.set(path, text); continue }
		let before = seen.get(path)
		if (before === text) continue
		seen.set(path, text)
		let what = before === null ? 'created' : text === null ? 'deleted' : 'changed'
		for (let c of watching) {
			if (path !== system && !applies.get(c)!.has(path)) continue
			let notice: NoticeEvent = { type: 'notice', session: c.visible!, name: basename(path), kind: 'update', what, line: paths.display(path), key: `prompt-file:${path}` }
			c.deliver(notice)
		}
	}
}

function start(clients: Iterable<Watcher>): void {
	if (promptFiles.state.timer) return
	promptFiles.state.timer = setInterval(() => {
		try { promptFiles.check(clients) } catch {}
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
	local, check, start, stop,
}
