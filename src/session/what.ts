import { ipc } from '../ipc.ts'
import { models } from '../models.ts'
import { provider as providerLoader } from '../providers/provider.ts'
import { protocol, type Message } from '../protocol.ts'
import { sessions, type HistoryEntry, type SessionMeta } from '../server/sessions.ts'
import { ason } from '../utils/ason.ts'
import { paths } from '../utils/paths.ts'
import { sessionEntry } from './entry.ts'

interface ResolvedTargets {
	ok: true
	ids: string[]
}

interface ResolveError {
	ok: false
	error: string
}

interface RunWhatOpts {
	requesterSessionId: string
	target: string
	openSessionIds: string[]
	model?: string
}

interface SummaryResult {
	title: string
	summary: string
}

const config = {
	maxEntries: 80,
	maxFieldChars: 1200,
	maxDigestChars: 24_000,
}

function normalize(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function unique(ids: string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const id of ids) {
		if (seen.has(id)) continue
		seen.add(id)
		out.push(id)
	}
	return out
}

function resolveOpenIndex(raw: string, openSessionIds: string[]): string | null {
	if (!/^\d+$/.test(raw)) return null
	const index = parseInt(raw, 10) - 1
	return openSessionIds[index] ?? null
}

function resolveOpenRange(raw: string, openSessionIds: string[]): string[] | null {
	const match = raw.match(/^(\d+)-(\d+)$/)
	if (!match) return null
	const start = parseInt(match[1]!, 10)
	const end = parseInt(match[2]!, 10)
	if (start < 1 || end < start || end > openSessionIds.length) return []
	return openSessionIds.slice(start - 1, end)
}

function resolveNamedTarget(raw: string, metas: SessionMeta[]): ResolvedTargets | ResolveError {
	const exactId = metas.find((meta) => meta.id === raw)
	if (exactId) return { ok: true, ids: [exactId.id] }

	const needle = normalize(raw)
	const exactNames = metas.filter((meta) => normalize(meta.name ?? '') === needle)
	if (exactNames.length === 1) return { ok: true, ids: [exactNames[0]!.id] }
	if (exactNames.length > 1) return { ok: false, error: `Ambiguous session name: ${raw}` }

	const partialNames = metas.filter((meta) => normalize(meta.name ?? '').includes(needle))
	if (partialNames.length === 1) return { ok: true, ids: [partialNames[0]!.id] }
	if (partialNames.length > 1) return { ok: false, error: `Ambiguous session name: ${raw}` }

	return { ok: false, error: `No session matches: ${raw}` }
}

function resolveTargets(target: string, requesterSessionId: string, openSessionIds: string[], metas = sessions.loadAllSessionMetas()): ResolvedTargets | ResolveError {
	const raw = target.trim()
	if (!raw) return { ok: true, ids: [requesterSessionId] }
	if (raw === '--all') return { ok: true, ids: [...openSessionIds] }

	const range = resolveOpenRange(raw, openSessionIds)
	if (range) {
		if (range.length === 0) return { ok: false, error: `Invalid tab range: ${raw}` }
		return { ok: true, ids: range }
	}

	const openId = resolveOpenIndex(raw, openSessionIds)
	if (openId) return { ok: true, ids: [openId] }

	return resolveNamedTarget(raw, metas)
}

function clip(text: string, max = config.maxFieldChars): string {
	if (text.length <= max) return text
	return `${text.slice(0, max).trimEnd()}\n[truncated ${text.length - max} chars]`
}


function sessionState(sessionId: string, openIndex: number, working: Record<string, boolean>): string {
	if (working[sessionId]) return 'working'
	if (openIndex >= 0) return 'idle/open'
	return 'closed'
}

function agentRole(meta: SessionMeta): string {
	if (meta.spawnKind === 'interactive') return 'interactive'
	if (meta.spawnKind === 'subagent' || meta.spawnKind === 'subagent-autoclose') return 'subagent'
	if (meta.forkedFrom) return 'fork'
	return 'primary'
}

function attributionLines(sessionId: string, meta: SessionMeta, openSessionIds: string[], working: Record<string, boolean>): string[] {
	const openIndex = openSessionIds.indexOf(sessionId)
	const lines = [
		'Attribution:',
		`Session id: ${sessionId}`,
		`Tab: ${openIndex >= 0 ? openIndex + 1 : 'closed'}`,
		`Name: ${meta.name ?? '(empty)'}`,
		`State: ${sessionState(sessionId, openIndex, working)}`,
		`Spawn kind: ${meta.spawnKind ?? '(none)'}`,
		`Agent role: ${agentRole(meta)}`,
	]
	if (meta.parentSessionId) lines.push(`Parent session id: ${meta.parentSessionId}`)
	if (meta.forkedFrom) lines.push(`Forked from: ${meta.forkedFrom}`)
	return lines
}

function attributionHeader(sessionId: string, openSessionIds: string[], working: Record<string, boolean>): string {
	const meta = sessions.loadSessionMeta(sessionId)
	const openIndex = openSessionIds.indexOf(sessionId)
	if (!meta) return `session ${sessionId}; tab ${openIndex >= 0 ? openIndex + 1 : 'closed'}`
	const parts = [
		`tab ${openIndex >= 0 ? openIndex + 1 : 'closed'}`,
		`session ${sessionId}`,
		`name ${meta.name ?? '(empty)'}`,
		`state ${sessionState(sessionId, openIndex, working)}`,
		`spawn ${meta.spawnKind ?? '(none)'}`,
		`role ${agentRole(meta)}`,
	]
	if (meta.parentSessionId) parts.push(`parent ${meta.parentSessionId}`)
	if (meta.forkedFrom) parts.push(`forked from ${meta.forkedFrom}`)
	return parts.join('; ')
}

function entryLine(sessionId: string, entry: HistoryEntry): string {
	const ts = entry.ts ? ` ${entry.ts}` : ''
	if (entry.type === 'user') return `user${ts}: ${clip(sessionEntry.userText(entry, { images: 'path-or-blob-or-image' }))}`
	if (entry.type === 'assistant') return `assistant${ts}: ${clip(entry.text)}`
	if (entry.type === 'thinking') return `thinking${ts}: ${entry.blobId ? `[blob ${entry.blobId}]` : clip(entry.text ?? '')}`
	if (entry.type === 'tool_call') return `tool_call${ts}: ${entry.name} ${clip(ason.stringify(entry.input ?? sessionEntry.loadEntryBlob(sessionId, entry)?.call?.input ?? {}, 'short'))}`
	if (entry.type === 'tool_result') return `tool_result${ts}: ${clip(toolResultText(sessionId, entry))}`
	if (entry.type === 'turn_end') return `turn_end${ts}: ${entry.status}`
	if (entry.type === 'log' || entry.type === 'info' || entry.type === 'warning' || entry.type === 'error') return `${entry.type}${ts}: ${clip(entry.text)}`
	if (entry.type === 'cwd') return `cwd${ts}: ${entry.from} -> ${entry.to}`
	if (entry.type === 'model') return `model${ts}: ${entry.from} -> ${entry.to}`
	return `${entry.type}${ts}`
}

function toolResultText(sessionId: string, entry: Extract<HistoryEntry, { type: 'tool_result' }>): string {
	let value = entry.output
	if (value === undefined) value = sessionEntry.loadEntryBlob(sessionId, entry)?.result?.content
	if (value === undefined) return '[no output stored]'
	if (typeof value === 'string') return value
	return ason.stringify(value, 'short')
}

function liveText(sessionId: string): string {
	const live = sessions.loadLive(sessionId)
	if (!live.blocks || live.blocks.length === 0) return ''
	const lines = ['Live blocks:']
	for (const block of live.blocks.slice(-10)) lines.push(`- ${clip(ason.stringify(block, 'short'), 800)}`)
	return lines.join('\n')
}


function isHighlight(entry: HistoryEntry): boolean {
	return entry.type === 'user'
		|| entry.type === 'assistant'
		|| entry.type === 'info'
		|| entry.type === 'log'
		|| entry.type === 'warning'
		|| entry.type === 'error'
		|| entry.type === 'cwd'
		|| entry.type === 'model'
		|| entry.type === 'forked_from'
		|| entry.type === 'forked_to'
		|| entry.type === 'rebased_from'
		|| entry.type === 'rebased_to'
}

function isCommitEvidenceLine(line: string): boolean {
	return /\bgit\s+commit\b/.test(line)
		|| line.includes('[hal-commit]')
		|| /^tool_result.*\[[^\]]+ [0-9a-f]{7,}\]/.test(line)
}

function appendWithinBudget(lines: string[], additions: string[], maxChars: number): void {
	for (const addition of additions) {
		const separator = lines.length > 0 ? 1 : 0
		const used = lines.join('\n').length
		if (used + separator + addition.length <= maxChars) {
			lines.push(addition)
			continue
		}
		const remaining = maxChars - used - separator
		if (remaining > 40) lines.push(clip(addition, remaining))
		lines.push('[remaining details clipped]')
		return
	}
}

function buildDigest(sessionId: string, openSessionIds: string[], working: Record<string, boolean>): string {
	const meta = sessions.loadSessionMeta(sessionId)
	if (!meta) return `Session ${sessionId} not found.`
	const entries = sessions.loadAllHistory(sessionId)
	const recent = entries.slice(-config.maxEntries)
	const highlights: string[] = []
	const commitEvidence: string[] = []
	const details: string[] = []
	for (const entry of recent) {
		const line = entryLine(sessionId, entry)
		if (isCommitEvidenceLine(line)) commitEvidence.push(line)
		else if (isHighlight(entry)) highlights.push(line)
		else details.push(line)
	}
	const lines = [
		...attributionLines(sessionId, meta, openSessionIds, working),
		`Created: ${meta.createdAt}`,
		...(meta.closedAt ? [`Closed: ${meta.closedAt}`] : []),
		`Cwd: ${meta.workingDir ?? ''}`,
		`Model: ${meta.model ?? models.defaultModel()}`,
		`History: ${paths.historyDisplayPath(sessionId, meta.currentLog)}`,
		`Session dir: ${paths.formatHomePath(sessions.sessionDir(sessionId))}`,
		`Entries: ${entries.length}`,
		'',
		'Conversation and meta highlights:',
	]
	appendWithinBudget(lines, highlights.length > 0 ? highlights : ['[none]'], Math.floor(config.maxDigestChars * 0.75))
	lines.push('', 'Commit evidence:')
	appendWithinBudget(lines, commitEvidence.length > 0 ? commitEvidence : ['[none]'], Math.floor(config.maxDigestChars * 0.85))
	lines.push('', 'Tool/action details:')
	appendWithinBudget(lines, details.length > 0 ? details : ['[none]'], config.maxDigestChars)
	if (working[sessionId]) {
		lines.push('', liveText(sessionId))
	}
	return clip(lines.join('\n'), config.maxDigestChars)
}

function systemPrompt(): string {
	return [
		'You write session-recall briefs for Hal coding-agent sessions.',
		'Return only ASON with fields: title, summary.',
		'Title must be short, lower-case, descriptive, and at most 60 characters.',
		'Summary must use these fixed sections, in this order: Attribution; What user asked; Why / goal; Clarifications and design; Plan / approval; Work done and current state; Commits made; Files, actions, and evidence; Next steps / open questions.',
		'Focus on what the user asked for, why, clarifying questions Hal asked, what was clarified or designed, architectural decisions, whether a plan was made or approved, and commits made.',
		'When commits are visible, mention abbreviated commit hashes and one-line summaries; if no commits are visible, say "none visible".',
		'Do not invent missing why, approval, files, commits, or decisions; say "not visible" or "not stated" when the digest does not show them.',
		'Ignore routine tool noise such as raw command output, repetitive file listings, and implementation detail unless it explains a decision, changed file, commit, failure, or current state.',
		'Preserve attribution from the digest, including tab/closed state, session id, name, state, spawn kind or agent role, parent session id, and forked-from when present.'
	].join('\n')
}

function userPrompt(digest: string): string {
	return `Summarize this Hal session for quick recall.\n\n${digest}`
}

function parseSummary(text: string): SummaryResult {
	try {
		const parsed = ason.parse(text) as any
		return {
			title: sanitizeTitle(String(parsed?.title ?? '')),
			summary: String(parsed?.summary ?? '').trim() || text.trim(),
		}
	} catch {
		return { title: '', summary: text.trim() }
	}
}

function sanitizeTitle(text: string): string {
	return text.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 60).trim()
}

async function summarizeDigest(model: string, digest: string): Promise<SummaryResult> {
	const slash = model.indexOf('/')
	const providerName = slash >= 0 ? model.slice(0, slash) : 'stub'
	const modelId = slash >= 0 ? model.slice(slash + 1) : model
	const provider = await providerLoader.getProvider(providerName)
	const messages: Message[] = [{ role: 'user', content: userPrompt(digest) }]
	let text = ''
	for await (const event of provider.generate({ messages, model: modelId, systemPrompt: systemPrompt(), tools: [] })) {
		if (event.type === 'text') text += event.text ?? ''
		if (event.type === 'error') throw new Error(event.message ?? 'summary generation failed')
	}
	return parseSummary(text)
}

function formatSection(sessionId: string, result: SummaryResult, openSessionIds: string[], working: Record<string, boolean>): string {
	const meta = sessions.loadSessionMeta(sessionId)
	const title = result.title || meta?.name || sessionId
	return [`## ${title} (${attributionHeader(sessionId, openSessionIds, working)})`, '', result.summary].join('\n')
}

function maybeNameSession(sessionId: string, title: string): boolean {
	if (!title) return false
	const meta = sessions.loadSessionMeta(sessionId)
	if (!meta || meta.name) return false
	sessions.updateMeta(sessionId, { name: title })
	return true
}

function whatMetaText(targetIds: string[]): string {
	if (targetIds.length === 0) return 'User ran /what but no session matched.'
	return `User ran /what for session${targetIds.length === 1 ? '' : 's'} ${targetIds.join(', ')}.`
}

function persistResult(requesterSessionId: string, targetIds: string[], text: string): void {
	const ts = new Date().toISOString()
	sessions.appendHistorySync(requesterSessionId, [
		{ type: 'assistant', text, synthetic: true, syntheticKind: 'what-summary', visibility: 'ui', ts },
		{ type: 'info', text: whatMetaText(targetIds), visibility: 'next-user', ts },
	])
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'response',
		text,
		synthetic: true,
		sessionId: requesterSessionId,
		createdAt: ts,
	})
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

async function run(opts: RunWhatOpts): Promise<{ renamed: boolean }> {
	const metas = sessions.loadAllSessionMetas()
	const resolved = whatSummary.resolveTargets(opts.target, opts.requesterSessionId, opts.openSessionIds, metas)
	if (!resolved.ok) {
		persistResult(opts.requesterSessionId, [], resolved.error)
		return { renamed: false }
	}

	const requester = sessions.loadSessionMeta(opts.requesterSessionId)
	const model = opts.model ?? requester?.model ?? models.defaultModel()
	const shared = ipc.readState()
	const targetIds = unique(resolved.ids)
	const sections: string[] = []
	let renamed = false
	for (const sessionId of targetIds) {
		try {
			const digest = whatSummary.buildDigest(sessionId, opts.openSessionIds, shared.working ?? {})
			const summary = await whatSummary.summarizeDigest(model, digest)
			if (whatSummary.maybeNameSession(sessionId, summary.title)) renamed = true
			sections.push(formatSection(sessionId, summary, opts.openSessionIds, shared.working ?? {}))
		} catch (err) {
			sections.push([`## ${sessionId} (${attributionHeader(sessionId, opts.openSessionIds, shared.working ?? {})})`, '', `Summary failed: ${errorMessage(err)}`].join('\n'))
		}
	}
	persistResult(opts.requesterSessionId, targetIds, sections.join('\n\n'))
	return { renamed }
}

export const whatSummary = {
	config,
	resolveTargets,
	buildDigest,
	summarizeDigest,
	systemPrompt,
	maybeNameSession,
	run,
}
