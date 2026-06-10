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

function buildDigest(sessionId: string, openSessionIds: string[], working: Record<string, boolean>): string {
	const meta = sessions.loadSessionMeta(sessionId)
	if (!meta) return `Session ${sessionId} not found.`
	const openIndex = openSessionIds.indexOf(sessionId)
	const entries = sessions.loadAllHistory(sessionId)
	const recent = entries.slice(-config.maxEntries)
	const lines = [
		`Session: ${sessionId}`,
		`Tab: ${openIndex >= 0 ? openIndex + 1 : 'closed'}`,
		`Name: ${meta.name ?? '(empty)'}`,
		`State: ${working[sessionId] ? 'working' : openIndex >= 0 ? 'idle/open' : 'closed'}`,
		`Created: ${meta.createdAt}`,
		...(meta.closedAt ? [`Closed: ${meta.closedAt}`] : []),
		`Cwd: ${meta.workingDir ?? ''}`,
		`Model: ${meta.model ?? models.defaultModel()}`,
		`History: ${paths.historyDisplayPath(sessionId, meta.currentLog)}`,
		`Session dir: ${paths.formatHomePath(sessions.sessionDir(sessionId))}`,
		`Entries: ${entries.length}`,
		'',
		'Recent transcript:',
	]
	for (const entry of recent) lines.push(entryLine(sessionId, entry))
	if (working[sessionId]) {
		lines.push('', liveText(sessionId))
	}
	return clip(lines.join('\n'), config.maxDigestChars)
}

function systemPrompt(): string {
	return [
		'You summarize Hal coding-agent sessions for the user.',
		'Explain what the user asked, what Hal did, current state, files/actions if visible, and what might need attention next.',
		'Return only ASON with fields: title, summary.',
		'Title must be short, lower-case, descriptive, and at most 60 characters.',
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

function formatSection(sessionId: string, result: SummaryResult): string {
	const meta = sessions.loadSessionMeta(sessionId)
	const title = result.title || meta?.name || sessionId
	return [`## ${title} (${sessionId})`, '', result.summary].join('\n')
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
			sections.push(formatSection(sessionId, summary))
		} catch (err) {
			sections.push([`## ${sessionId}`, '', `Summary failed: ${errorMessage(err)}`].join('\n'))
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
	maybeNameSession,
	run,
}
