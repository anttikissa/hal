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
	targetIds?: string[]
	model?: string
	persist?: (sessionId: string, targetIds: string[], text: string) => void
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

function compactTargetLabel(sessionId: string, openSessionIds: string[]): string {
	const openIndex = openSessionIds.indexOf(sessionId)
	if (openIndex >= 0) return `tab ${openIndex + 1}`
	return `session ${sessionId}`
}

function entryLine(sessionId: string, entry: HistoryEntry): string {
	const ts = entry.ts ? ` ${entry.ts}` : ''
	if (entry.type === 'user') {
		const who = entry.source ? `prompt from session ${entry.source}` : 'user'
		return `${who}${ts}: ${clip(sessionEntry.userText(entry, { images: 'path-or-blob-or-image' }))}`
	}
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
	const opening: string[] = []
	const userRequests: string[] = []
	const recentHighlights: string[] = []
	const commitEvidence: string[] = []
	const details: string[] = []
	for (const entry of entries) {
		const line = entryLine(sessionId, entry)
		if (entry.type === 'user') userRequests.push(line)
		if (opening.length < 12 && isHighlight(entry)) opening.push(line)
	}
	for (const entry of recent) {
		const line = entryLine(sessionId, entry)
		if (isCommitEvidenceLine(line)) commitEvidence.push(line)
		else if (isHighlight(entry)) recentHighlights.push(line)
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
		'Opening conversation:',
	]
	appendWithinBudget(lines, opening.length > 0 ? opening : ['[none]'], Math.floor(config.maxDigestChars * 0.30))
	lines.push('', 'User request timeline:')
	appendWithinBudget(lines, userRequests.length > 0 ? userRequests : ['[none]'], Math.floor(config.maxDigestChars * 0.55))
	lines.push('', 'Recent conversation and meta highlights:')
	appendWithinBudget(lines, recentHighlights.length > 0 ? recentHighlights : ['[none]'], Math.floor(config.maxDigestChars * 0.75))
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
		'You write compact session-recall briefs for Hal coding-agent sessions.',
		'Output plain text only: a bare title on the first line, one blank line, then the summary.',
		'Do not use ASON, JSON, YAML, code fences, or labels such as "title:" and "summary:".',
		'Title must name the initiating user problem or task, not merely the last follow-up; keep it short, descriptive, and at most 60 characters.',
		'Summary should be a short narrative: usually 1-3 compact paragraphs plus at most 4 continuation-level bullets when useful.',
		'Write like Strunk and White: short, plain sentences. Omit needless words. Split long sentences.',
		'Address the reader as "you". Do not write "the user" unless quoting text.',
		'If a prompt came from another session, say that plainly when it matters, for example "Session 47-abc asked this session to ...".',
		'Lead with what you asked for and the main conversation arc, then mention major pivots or follow-ups only if they matter for continuing the work.',
		'Include why/context, clarifications, design or architectural decisions, and plan approval only when they are actually visible and useful.',
		'Every sentence must help a human remember the user intent or continue the session; omit zero-information lines such as "no next steps", "no plan visible", or metadata inventories.',
		'Do not show session id, tab, cwd, model, history path, entry counts, state, or role unless that provenance directly explains who did the work.',
		'Mention files/actions only at continuation-level detail; do not create a separate file/evidence section unless there is an unresolved issue.',
		'When commits are visible, mention only the final relevant abbreviated commit hash and one-line title; omit amended/intermediate commits, commit bodies, and trailers. If no commit matters, omit commits entirely.',
		'For successful validation, write "Tests passed." Do not list pass counts unless a failure or count mismatch matters.',
		'Do not invent missing why, approval, files, commits, or decisions; say less rather than filling checklist sections.',
		'Ignore routine tool noise, raw command output, repetitive file listings, and implementation detail unless it explains a decision, changed file, final commit, failure, or current state.',
		'Use exact quotes only when the wording itself matters.',
		'Do not copy any examples or unrelated prior summaries; the title and first paragraph must be grounded in the provided digest for the target session.',
	].join('\n')
}

function userPrompt(digest: string): string {
	return `Summarize this Hal session for quick recall.\n\n${digest}`
}

function parseSummary(text: string): SummaryResult {
	const lines = text.trim().split('\n')
	const title = sanitizeTitle(lines.shift() ?? '')
	return { title, summary: lines.join('\n').trim() }
}

function sanitizeTitle(text: string): string {
	return text.trim().replace(/\s+/g, ' ').slice(0, 60).trim()
}


async function summarizeDigest(model: string, digest: string): Promise<SummaryResult> {
	const slash = model.indexOf('/')
	const providerName = slash >= 0 ? model.slice(0, slash) : 'stub'
	const modelId = slash >= 0 ? model.slice(slash + 1) : model
	const provider = await providerLoader.getProvider(providerName)
	const messages: Message[] = [{ role: 'user', content: userPrompt(digest) }]
	let text = ''
	for await (const event of provider.generate({ messages, model: modelId, systemPrompt: whatSummary.systemPrompt(), tools: [], stateless: true })) {
		if (event.type === 'text') text += event.text ?? ''
		if (event.type === 'error') throw new Error(event.message ?? 'summary generation failed')
	}
	return whatSummary.parseSummary(text)
}

// A summary may be read days later, out of context, so it states up front that it is
// /what output and which session it describes.
function formatSection(sessionId: string, result: SummaryResult, openSessionIds: string[]): string {
	const meta = sessions.loadSessionMeta(sessionId)
	const title = result.title || meta?.name || sessionId
	const preamble = `You ran /what. This is a generated summary of earlier activity in ${compactTargetLabel(sessionId, openSessionIds)} (session ${sessionId}).`
	return [`## /what summary: ${title}`, '', preamble, '', result.summary].join('\n')
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
	if (targetIds.length === 1) return 'User ran /what for this session.'
	return `User ran /what for sessions ${targetIds.join(', ')}.`
}

function persistResult(sessionId: string, targetIds: string[], text: string): void {
	const ts = new Date().toISOString()
	sessions.appendHistorySync(sessionId, [
		{ type: 'assistant', text, synthetic: true, syntheticKind: 'what-summary', visibility: 'ui', ts },
		{ type: 'info', text: whatMetaText(targetIds), visibility: 'next-user', ts },
	])
	ipc.appendEvent({
		id: protocol.eventId(),
		type: 'response',
		text,
		synthetic: true,
		sessionId,
		createdAt: ts,
	})
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

async function run(opts: RunWhatOpts): Promise<{ renamed: boolean; targetIds: string[] }> {
	const metas = sessions.loadAllSessionMetas()
	const persist = opts.persist ?? whatSummary.persistResult
	let targetIds = unique(opts.targetIds ?? [])
	if (!opts.targetIds) {
		const resolved = whatSummary.resolveTargets(opts.target, opts.requesterSessionId, opts.openSessionIds, metas)
		if (!resolved.ok) {
			persist(opts.requesterSessionId, [], resolved.error)
			return { renamed: false, targetIds: [] }
		}
		targetIds = unique(resolved.ids)
	}

	const requester = sessions.loadSessionMeta(opts.requesterSessionId)
	const model = opts.model ?? requester?.model ?? models.defaultModel()
	const shared = ipc.readState()
	let renamed = false
	for (const sessionId of targetIds) {
		try {
			const digest = whatSummary.buildDigest(sessionId, opts.openSessionIds, shared.working ?? {})
			const summary = await whatSummary.summarizeDigest(model, digest)
			if (whatSummary.maybeNameSession(sessionId, summary.title)) renamed = true
			persist(sessionId, [sessionId], formatSection(sessionId, summary, opts.openSessionIds))
		} catch (err) {
			persist(sessionId, [sessionId], [`## /what summary: ${sessionId}`, '', `Summary failed: ${errorMessage(err)}`].join('\n'))
		}
	}
	return { renamed, targetIds }
}

export const whatSummary = {
	config,
	resolveTargets,
	buildDigest,
	summarizeDigest,
	systemPrompt,
	parseSummary,
	maybeNameSession,
	persistResult,
	run,
}
