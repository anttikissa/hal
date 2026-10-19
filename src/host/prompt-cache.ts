// Freezes each session's system prompt so the provider's prompt cache
// keeps hitting, and reports later prompt changes as history notes.
//
// HOW CHANGES REACH THE MODEL
//
// The system prompt sent to the provider never changes mid-session.
// When SYSTEM.md, AGENTS.md, a skill, the tool list or a session
// setting changes, prepare() compares the old rendering with the new
// one, section by section, and appends one notice that starts with
// "System prompt changed:". The model keeps its own copy of each
// section: the frozen system prompt plus every change note since.
//
// Each changed section gets one of five forms (see updates()):
//
//   # T [section changed; new contents follow]   full body; the default
//   # T [section changed; diff follows]          update="diff" sections
//   # T [section changed; diff and new contents follow]
//                                                diff, then "New contents:"
//                                                and the full body; only
//                                                after a rebase, see below
//   # T [new section]                            full body
//   # T [section removed; its instructions no longer apply]
//
// WHY "DIFF AND NEW CONTENTS" EXISTS
//
// A diff is right only if the model's copy equals Hal's "old" side.
// Normally it does: the model saw every earlier note. A /rebase, or a
// setting change made through one, can drop or edit earlier notes,
// and then the two copies drift apart. Example with the "Session"
// section, an update="diff" section:
//
//   1. The frozen prompt says  Autoclose: false  and  Cwd: /x.
//   2. Autoclose turns on; Hal notes  -Autoclose: false  +Autoclose: true.
//   3. The user rebases and drops that note. The model now believes
//      Autoclose: false, but Hal's last rendering says true.
//   4. The user runs /cd /y; Hal notes  -Cwd: /x  +Cwd: /y.
//
// The diff in step 4 is correct but never mentions the Autoclose
// line, so without help the model would believe "false" forever. After
// any rebase, every diff update therefore also carries the full new
// body, which restates every line. The diff stays so the model still
// sees what changed (for example the previous cwd).
//
// data.reconcile marks this state. A rebase sets it (prepare() sees a
// newer rebase record, or rebases.ts calls rebased()); only a full
// rebuild of the system prompt clears it, because only then do the
// copies match again. Until then, every diff update uses "diff and new
// contents", not just the first. Hal never sends a note only to repair a
// rebase; the full body rides along with the next real change.
//
// Not done: diffing against the model's actual copy (frozen prompt
// plus surviving notes). It would need replaying those notes; the
// full body is simpler, at the cost of a longer note after a rebase.

import { readFileSync } from 'fs'
import type { HistoryRecord } from '../common/replay.ts'
import { liveFiles } from './live-file.ts'
import { history } from './history.ts'
import { models } from './models.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { systemPrompt, type PromptInput } from './system-prompt.ts'
import type { PromptSection } from './prompt-lang.ts'
import { textDiff } from './text-diff.ts'
import { warnings } from './warnings.ts'

type Rendering = { text: string; sections: PromptSection[] }
type Cache = { system?: string; latest?: Rendering; model?: string; family?: string; epoch?: number; boundary?: number; omitted?: number; lastRebase?: number; rebased?: true; reconcile?: true; baseline?: Rendering; input?: PromptInput; fault?: string }

function file(id: string): Cache {
	let cached = promptCache.state.files.get(id)
	if (cached) return cached
	let path = `${paths.sessionDir(id)}/prompt.ason`
	let data = liveFiles.liveFile<Cache>(path, {}, { watch: false })
	for (let key of ['system', 'model', 'family', 'fault'] as const) if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error(`${path}: invalid ${key}`)
	for (let key of ['latest', 'baseline'] as const) {
		let rendering = data[key]
		if (rendering && (typeof rendering.text !== 'string' || !Array.isArray(rendering.sections) || rendering.sections.some((s) => !s || typeof s.title !== 'string' || typeof s.body !== 'string' || !['full', 'diff'].includes(s.update) || !Array.isArray(s.variables) || !s.variables.every((v) => typeof v === 'string') || !Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end) || s.start < 0 || s.end < s.start))) throw new Error(`${path}: invalid ${key} rendering`)
	}
	for (let key of ['boundary', 'omitted', 'lastRebase', 'epoch'] as const) if (data[key] !== undefined && (!Number.isSafeInteger(data[key]) || data[key]! < 0)) throw new Error(`${path}: invalid ${key}`)
	for (let key of ['rebased', 'reconcile'] as const) if (data[key] !== undefined && data[key] !== true) throw new Error(`${path}: invalid ${key}`)
	promptCache.state.files.set(id, data)
	return data
}

function interactive(id: string): boolean {
	let records = history.readSync(id)
	for (let i = records.length - 1; i >= 0; i--) {
		let record = records[i]!
		if (record.type !== 'user') continue
		let human = record.blocks.findLast((b) => b.type === 'text' && b.from === undefined && b.origin !== 'model')
		if (human?.type === 'text') return human.interactive ?? true
	}
	return sessions.open(id).interactive ?? true
}

// state.noUser: this host process runs with --no-user, so no tab's
// prompt has USER.md.
function input(id: string, selected?: PromptInput): PromptInput {
	let meta = sessions.open(id)
	return { cwd: meta.cwd, model: models.qualified(meta.model, meta.effort), now: Date.now(), sessionId: id, noUser: promptCache.state.noUser, interactive: promptCache.interactive(id), owner: meta.owner, parent: meta.parent, slots: meta.slots, autoclose: meta.autoclose, ...selected }
}

function outside(rendered: Rendering): string {
	let parts: string[] = [], from = 0
	for (let s of rendered.sections) if (s.end > s.start) { parts.push(rendered.text.slice(from, s.start)); from = s.end }
	parts.push(rendered.text.slice(from))
	return parts.map((s) => s.replace(/^\n+|\n+$/g, '')).filter(Boolean).join('\n\n')
}

// One change note body: a block per changed, added or removed section.
// reconcile: a rebase may have desynced the model's copy, so diff
// updates also restate the full body (see the file header).
function updates(before: PromptSection[], after: PromptSection[], reconcile = false): string {
	let previous = new Map(before.filter((s) => s.body.trim()).map((s) => [s.title, s]))
	let current = new Map(after.filter((s) => s.body.trim()).map((s) => [s.title, s]))
	let changes: string[] = []
	for (let [title, old] of previous) {
		let now = current.get(title)
		if (!now) changes.push(`# ${title} [section removed; its instructions no longer apply]`)
		else if (old.body !== now.body) changes.push(now.update === 'diff'
			? reconcile
				? `# ${title} [section changed; diff and new contents follow]\n${textDiff.text(`${old.body}\n`, `${now.body}\n`)}\nNew contents:\n${now.body}`
				: `# ${title} [section changed; diff follows]\n${textDiff.text(`${old.body}\n`, `${now.body}\n`)}`
			: `# ${title} [section changed; new contents follow]\n${now.body}`)
	}
	for (let [title, now] of current) if (!previous.has(title)) changes.push(`# ${title} [new section]\n${now.body}`)
	return changes.join('\n\n')
}

function report(id: string, fault: string, data: Cache): void {
	if (warnings.state.standing.get(`system:${id}`) !== (fault || undefined)) warnings.set(`system:${id}`, fault || undefined)
	if (data.fault !== fault) {
		if (fault) history.append(id, { type: 'notice', text: fault })
		data.fault = fault
	}
}

function prepare(id: string, selected?: PromptInput): { system: string; cacheId: string } {
	let data = promptCache.file(id), snapshot = promptCache.input(id, selected)
	let rendered = systemPrompt.inspect(snapshot)
	let fault = rendered.problems.length ? `SYSTEM.md is broken (${systemPrompt.file()}):\n${rendered.problems.join('\n')}` : ''
	promptCache.report(id, fault, data)
	let current = history.readSync(id)
	let latestRebase = current.findLast((r) => r.type === 'rebase')
	if ((latestRebase?.n ?? 0) > (data.lastRebase ?? 0)) {
		data.reconcile = true; data.lastRebase = latestRebase!.n
		if (latestRebase?.contextChanged && !data.baseline) data.rebased = true
	}
	let boundary = current.findLast((r) => r.type === 'reset' || r.type === 'compact')?.n ?? 0
	let familyId = data.family ?? id
	let family = liveFiles.liveFile<{ lastRequest?: number; epoch?: number }>(`${paths.sessionDir(familyId)}/prompt-family.ason`, {}, { watch: false })
	if (family.lastRequest !== undefined && !Number.isFinite(family.lastRequest)) throw new Error(`${paths.sessionDir(familyId)}/prompt-family.ason: invalid lastRequest`)
	if (family.epoch !== undefined && (!Number.isSafeInteger(family.epoch) || family.epoch < 0)) throw new Error(`${paths.sessionDir(familyId)}/prompt-family.ason: invalid epoch`)
	if (family.lastRequest !== undefined && snapshot.now - family.lastRequest >= promptCache.inactivityMs) family.epoch = (family.epoch ?? 0) + 1
	let expired = (data.epoch ?? 0) !== (family.epoch ?? 0)
	let rebuild = !data.latest || (data.input?.interactive ?? true) !== snapshot.interactive || data.boundary !== boundary || (!data.rebased && data.model !== models.selection(snapshot.model).id) || expired
	family.lastRequest = snapshot.now
	liveFiles.close(family)
	if (fault) {
		if (!data.system) {
			let raw: string
			try { raw = readFileSync(systemPrompt.file(), 'utf8') } catch (e: any) { raw = String(e?.message ?? e) }
			data.system = `${fault}\nHelp the user fix SYSTEM.md. Its raw content follows:\n${raw}`
		}
		liveFiles.save(data)
		return { system: data.system, cacheId: familyId }
	}
	if (rebuild) {
		data.system = rendered.text
		data.epoch = family.epoch ?? 0
		delete data.baseline; delete data.rebased; delete data.reconcile
		data.omitted = current.reduce((n, r) => Math.max(n, r.n ?? 0), 0)
	} else {
		let old = data.baseline ?? data.latest
		delete data.baseline
		if (data.rebased && old) {
			let changed = ['cwd', 'model', 'autoclose'] as const
			let keys = changed.filter((k) => data.input?.[k] !== snapshot[k])
			let baseline = old.sections.map((s) => s.variables.some((v) => keys.some((k) => v === `session_${k}`) || (v === 'agents' && keys.includes('cwd'))) ? rendered.sections.find((n) => n.title === s.title) ?? { ...s, body: '' } : s)
			old = { ...old, sections: baseline }
			delete data.rebased
		}
		if (old) {
			if (promptCache.outside(old) !== promptCache.outside(rendered)) {
				data.system = rendered.text
				data.omitted = current.reduce((n, r) => Math.max(n, r.n ?? 0), 0)
				history.append(id, { type: 'notice', text: 'Instructions outside sections changed. The system prompt is current; earlier replies followed the old text.' })
			} else {
				let text = promptCache.updates(old.sections, rendered.sections, data.reconcile)
				if (text) history.append(id, { type: 'notice', text: `System prompt changed:\n\n${text}`, sectionUpdate: true })
			}
		}
	}
	if (data.latest?.text !== rendered.text || JSON.stringify(data.latest.sections) !== JSON.stringify(rendered.sections)) data.latest = { text: rendered.text, sections: rendered.sections }
	let { now: _now, ...stableInput } = snapshot
	let storedInput = { ...stableInput, now: 0 }
	if (JSON.stringify(data.input) !== JSON.stringify(storedInput)) data.input = storedInput
	data.model = models.selection(snapshot.model).id
	data.family = familyId
	data.boundary = boundary
	liveFiles.save(data)
	return { system: data.system!, cacheId: familyId }
}

function project(id: string, records: HistoryRecord[]): HistoryRecord[] {
	let cutoff = promptCache.file(id).omitted ?? 0
	return records.filter((r) => !(r.type === 'notice' && r.sectionUpdate && (r.n ?? 0) <= cutoff)).map((r) => r.type === 'user' && r.notices?.some((n) => n.sectionUpdate && n.source <= cutoff)
		? { ...r, notices: r.notices.filter((n) => !n.sectionUpdate || n.source > cutoff) } : r)
}

function inherit(parent: string, child: string): void {
	let source = promptCache.file(parent), target = promptCache.file(child)
	if (source.system) Object.assign(target, JSON.parse(JSON.stringify(source)), { family: source.family ?? parent, boundary: history.readSync(child).findLast((r) => r.type === 'reset' || r.type === 'compact')?.n ?? 0 })
	liveFiles.save(target)
}
function rebased(id: string): void {
	let data = promptCache.file(id), snapshot = promptCache.input(id), baseline = systemPrompt.inspect(snapshot)
	data.reconcile = true; data.model = models.selection(snapshot.model).id
	if (!baseline.problems.length) { data.baseline = { text: baseline.text, sections: baseline.sections }; delete data.rebased }
	else data.rebased = true
	liveFiles.save(data)
}
function close(id: string): void { let data = promptCache.state.files.get(id); if (data) liveFiles.close(data); promptCache.state.files.delete(id); warnings.set(`system:${id}`) }
function closeAll(): void { for (let id of promptCache.state.files.keys()) promptCache.close(id) }

export const promptCache = { state: { files: new Map<string, Cache>(), noUser: false }, inactivityMs: 3_600_000, file, interactive, input, outside, updates, report, prepare, project, inherit, rebased, close, closeAll }
