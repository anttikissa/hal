import type { HistoryEntry } from '../server/sessions.ts'
import { ason } from '../utils/ason.ts'
import { visLen } from '../utils/strings.ts'
import { time } from '../utils/time.ts'
import { sessionEntry } from './entry.ts'
import { attachments } from './attachments.ts'
import { STATE_DIR } from '../state.ts'

const ID_RE = /^[a-z0-9]{6}-[a-z0-9]{3}$/
const COMMENT_COLUMN = 66
const MAX_CONTENT_COLUMNS = 42

type RebaseCommand = 'pick' | 'edit' | 'drop' | 'queue'

type RebaseRow = {
	id: string
	type: string
	entries: HistoryEntry[]
	content: unknown
	contentText: string
	truncated: boolean
	editable: boolean
	comment: string
	cmd?: RebaseCommand
}

type RebaseSnapshot = {
	sessionId: string
	baseLog: string
	baseHash?: string
	rows: RebaseRow[]
}

type ParsedItem = {
	cmd: RebaseCommand
	id?: string
	type?: string
	row?: RebaseRow
	content?: unknown
	queueText?: string
	line: string
}

type ParsedTodo = {
	items: ParsedItem[]
	errors: string[]
	aborted: boolean
}

type ParseTodoOptions = {
	edits?: Record<string, string>
}

type ApplyResult = {
	entries: HistoryEntry[]
	queue: string[]
}

function legacyRowId(index: number): string {
	const head = (index + 1).toString(36).padStart(6, '0')
	const tail = `r${(index % 36).toString(36).padStart(2, '0')}`
	return `${head}-${tail}`
}

function entryRowId(entry: HistoryEntry, index: number): string {
	if (typeof entry.id === 'string') return entry.id
	const anyEntry = entry as any
	if (typeof anyEntry.blobId === 'string') return anyEntry.blobId
	return legacyRowId(index)
}

function entryTime(entry: HistoryEntry): number | undefined {
	if (!entry.ts) return undefined
	const value = Date.parse(entry.ts)
	return Number.isFinite(value) ? value : undefined
}

function rowTime(entries: HistoryEntry[]): number | undefined {
	for (const entry of entries) {
		const value = entryTime(entry)
		if (value !== undefined) return value
	}
	return undefined
}

function formatRowTime(entries: HistoryEntry[], now = Date.now()): string {
	const ts = rowTime(entries)
	return ts ? time.formatTimestamp(ts, now) : ''
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
	return structuredClone(entry) as HistoryEntry
}

function textStats(text: string): string {
	const parts: string[] = []
	const lines = text.split('\n').length
	if (lines > 1) parts.push(`${lines} lines`)
	const bytes = new TextEncoder().encode(text).length
	if (bytes >= 1000) parts.push(`${Math.round(bytes / 100) / 10}kB`)
	else if (bytes >= 250) parts.push(`${bytes} chars`)
	return parts.join(', ')
}

function truncateContent(text: string): { text: string; truncated: boolean } {
	if (!text.includes('\n') && visLen(text) <= MAX_CONTENT_COLUMNS) return { text, truncated: false }
	let out = ''
	for (const ch of text.replace(/\n/g, '\\n')) {
		if (visLen(`${out}${ch}...`) > MAX_CONTENT_COLUMNS) break
		out += ch
	}
	return { text: `${out}...`, truncated: true }
}

function clipContentToColumns(text: string, max: number): { text: string; truncated: boolean } {
	if (visLen(text) <= max) return { text, truncated: false }
	if (max <= 3) return { text: '.'.repeat(Math.max(0, max)), truncated: true }
	let out = ''
	for (const ch of text) {
		if (visLen(`${out}${ch}...`) > max) break
		out += ch
	}
	return { text: `${out}...`, truncated: true }
}

function makeTextRow(id: string, type: string, entry: HistoryEntry, text: string, editable: boolean, now: number): RebaseRow {
	const rendered = ason.stringify(text, 'short')
	const clipped = truncateContent(rendered)
	const notes = [formatRowTime([entry], now), clipped.truncated ? 'truncated' : '', textStats(text)].filter(Boolean).join('; ')
	return { id, type, entries: [entry], content: text, contentText: clipped.text, truncated: clipped.truncated, editable, comment: notes }
}

function makeProtectedRow(id: string, type: string, entries: HistoryEntry[], content: unknown, comment: string): RebaseRow {
	const rendered = ason.stringify(content, 'short')
	const clipped = truncateContent(rendered)
	return { id, type, entries, content, contentText: clipped.text, truncated: clipped.truncated, editable: false, comment }
}

function buildNormalRow(sessionId: string, entry: HistoryEntry, index: number, now: number): RebaseRow {
	const id = entryRowId(entry, index)
	if (entry.type === 'user') return makeTextRow(id, 'user', entry, sessionEntry.userText(entry, { images: 'path-or-blob-or-image' }), true, now)
	if (entry.type === 'assistant') return makeTextRow(id, 'assistant', entry, entry.text, true, now)
	if (entry.type === 'thinking') {
		const text = entry.text ?? sessionEntry.loadEntryBlob(sessionId, entry)?.thinking ?? ''
		const row = makeTextRow(id, 'thinking', entry, text, false, now)
		row.comment = [formatRowTime([entry], now), entry.signature ? 'signed' : '', entry.thinkingEffort, textStats(text)].filter(Boolean).join('; ')
		return row
	}
	if (entry.type === 'cwd') return makeProtectedRow(id, 'cwd', [entry], [entry.from, entry.to], `${formatRowTime([entry], now)}; next-user`)
	if (entry.type === 'model') return makeProtectedRow(id, 'model', [entry], [entry.from, entry.to], `${formatRowTime([entry], now)}; next-user`)
	if (entry.type === 'input_history') return makeProtectedRow(id, 'input_history', [entry], entry.text, formatRowTime([entry], now))
	if (entry.type === 'rebased_from' || entry.type === 'rebased_to') return makeProtectedRow(id, entry.type, [entry], { log: entry.log }, formatRowTime([entry], now))
	if ('text' in entry && typeof entry.text === 'string') return makeProtectedRow(id, entry.type, [entry], entry.text, formatRowTime([entry], now))
	return makeProtectedRow(id, entry.type, [entry], { type: entry.type }, formatRowTime([entry], now))
}

function toolContent(call: Extract<HistoryEntry, { type: 'tool_call' }>, result?: Extract<HistoryEntry, { type: 'tool_result' }>): unknown {
	const body: Record<string, unknown> = {}
	body[call.name] = call.input ?? {}
	if (result?.isError) body.error = true
	return body
}

function buildToolRows(entries: HistoryEntry[], start: number, end: number, now: number): RebaseRow[] {
	const calls: Array<{ entry: Extract<HistoryEntry, { type: 'tool_call' }>; index: number }> = []
	const results = new Map<string, { entry: Extract<HistoryEntry, { type: 'tool_result' }>; index: number }>()
	const stray: Array<{ entry: Extract<HistoryEntry, { type: 'tool_result' }>; index: number }> = []
	for (let i = start; i <= end; i++) {
		const entry = entries[i]!
		if (entry.type === 'tool_call') calls.push({ entry, index: i })
		if (entry.type === 'tool_result') {
			if (calls.some((call) => call.entry.toolId === entry.toolId)) results.set(entry.toolId, { entry, index: i })
			else stray.push({ entry, index: i })
		}
	}
	const rows: RebaseRow[] = []
	for (const call of calls) {
		const result = results.get(call.entry.toolId)
		const id = entryRowId(call.entry, call.index)
		const entriesForRow = result ? [call.entry, result.entry] : [call.entry]
		const comment = [formatRowTime(entriesForRow, now), result ? textStats(String(result.entry.output ?? '')) : 'interrupted'].filter(Boolean).join('; ')
		rows.push(makeProtectedRow(id, 'tool', entriesForRow, toolContent(call.entry, result?.entry), comment))
	}
	for (const item of stray) {
		const id = entryRowId(item.entry, item.index)
		rows.push(makeProtectedRow(id, 'tool', [item.entry], { result: item.entry.toolId }, `${formatRowTime([item.entry], now)}; stray result`))
	}
	return rows
}

function findToolBatchEnd(entries: HistoryEntry[], start: number): number {
	const outstanding = new Set<string>()
	let sawCall = false
	for (let i = start; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.type !== 'tool_call' && entry.type !== 'tool_result') return Math.max(start, i - 1)
		if (entry.type === 'tool_call') {
			sawCall = true
			outstanding.add(entry.toolId)
		}
		if (entry.type === 'tool_result') outstanding.delete(entry.toolId)
		if (sawCall && outstanding.size === 0) return i
	}
	return entries.length - 1
}

function buildSnapshot(sessionId: string, baseLog: string, entries: HistoryEntry[], opts: { now?: Date } = {}): RebaseSnapshot {
	const rows: RebaseRow[] = []
	const now = opts.now?.getTime() ?? Date.now()
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.type === 'tool_call' || entry.type === 'tool_result') {
			const end = findToolBatchEnd(entries, i)
			rows.push(...buildToolRows(entries, i, end, now))
			i = end
			continue
		}
		rows.push(buildNormalRow(sessionId, entry, i, now))
	}
	return { sessionId, baseLog, rows }
}

function renderRow(row: RebaseRow & { cmd?: RebaseCommand }): string {
	const cmd = row.cmd ?? 'pick'
	const prefix = `${cmd} ${row.id} ${row.type} `
	let contentText = row.contentText
	if (row.comment) {
		const maxContentWidth = Math.max(0, COMMENT_COLUMN - 1 - visLen(prefix))
		const clipped = clipContentToColumns(contentText, maxContentWidth)
		contentText = clipped.text
		if (clipped.truncated) {
			row.contentText = contentText
			row.truncated = true
		}
	}
	const head = `${prefix}${contentText}`
	if (!row.comment) return head
	const width = visLen(head)
	const gap = width < COMMENT_COLUMN ? ' '.repeat(COMMENT_COLUMN - width) : ''
	return `${head}${gap}# ${row.comment}`
}

function renderTodo(snapshot: RebaseSnapshot): string {
	const nextLog = nextHistoryLog(snapshot.baseLog)
	const basePath = `${STATE_DIR}/sessions/${snapshot.sessionId}/${snapshot.baseLog}`
	const lines = [
		`# Interactive rebase of ${basePath} (new file: ${nextLog})`,
		'# Commands: pick, edit, drop, queue, abort',
		'# Short lines can be edited in-place',
		"# Any line with the command 'abort', or an empty file, aborts the rebase",
		"# Lines with 'queue' must appear last; they are immediately sent after the rebase operation",
		'# Queue lines can appear like this:',
		"# queue 000001-aaa user 'edited prompt'            # changing a 'pick' line to 'queue'",
		`# queue "quotes; what's up"`,
		'# queue send this without quotes',
		'',
		...snapshot.rows.map((row) => renderRow(row)),
	]
	return `${lines.join('\n')}\n`
}

function editTexts(snapshot: RebaseSnapshot): Record<string, string> {
	const out: Record<string, string> = {}
	for (const row of snapshot.rows) {
		if (row.editable && typeof row.content === 'string') out[row.id] = row.content
	}
	return out
}

function nextHistoryLog(baseLog: string): string {
	const match = baseLog.match(/^history(\d*)\.asonl$/)
	if (!match) return 'history2.asonl'
	const current = match[1] ? parseInt(match[1], 10) : 1
	return `history${current + 1}.asonl`
}

function rowMap(snapshot: RebaseSnapshot): Map<string, RebaseRow> {
	const map = new Map<string, RebaseRow>()
	for (const row of snapshot.rows) map.set(row.id, row)
	return map
}

function normalizeCommand(raw: string): RebaseCommand | 'abort' | null {
	if (raw === 'p') return 'pick'
	if (raw === 'pick') return 'pick'
	if (raw === 'e') return 'edit'
	if (raw === 'edit') return 'edit'
	if (raw === 'd') return 'drop'
	if (raw === 'drop') return 'drop'
	if (raw === 'q') return 'queue'
	if (raw === 'queue') return 'queue'
	if (raw === 'a') return 'abort'
	if (raw === 'abort') return 'abort'
	return null
}

function splitFirstToken(text: string): { token: string; rest: string } {
	const trimmed = text.trimStart()
	const match = trimmed.match(/^(\S+)([\s\S]*)$/)
	if (!match) return { token: '', rest: '' }
	return { token: match[1]!, rest: match[2]!.trimStart() }
}

function scanAsonValue(text: string): { valueText: string; rest: string } | null {
	let quote = ''
	let escape = false
	let depth = 0
	let started = false
	let end = -1
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!
		if (!started) {
			if (/\s/.test(ch)) continue
			started = true
		}
		if (quote) {
			if (escape) {
				escape = false
				continue
			}
			if (ch === '\\') {
				escape = true
				continue
			}
			if (ch === quote) {
				quote = ''
				if (depth === 0) {
					end = i + 1
					break
				}
			}
			continue
		}
		if (ch === '\'' || ch === '"' || ch === '`') {
			quote = ch
			continue
		}
		if (ch === '{' || ch === '[' || ch === '(') depth++
		else if (ch === '}' || ch === ']' || ch === ')') {
			depth--
			if (depth === 0) {
				end = i + 1
				break
			}
		} else if (depth === 0 && /\s/.test(ch)) {
			end = i
			break
		}
	}
	if (!started) return null
	if (end < 0 && !quote && depth === 0) end = text.length
	if (end < 0) return null
	return { valueText: text.slice(0, end).trim(), rest: text.slice(end).trimStart() }
}

function parseOneAson(text: string): { value: unknown; rest: string } | null {
	const scanned = scanAsonValue(text)
	if (!scanned) return null
	return { value: ason.parse(scanned.valueText), rest: scanned.rest }
}

function stripRawComment(text: string): string {
	const index = text.indexOf('#')
	return (index >= 0 ? text.slice(0, index) : text).trim()
}

function parseQueue(rest: string, rows: Map<string, RebaseRow>, line: string, errors: string[]): ParsedItem {
	const first = splitFirstToken(rest)
	const row = ID_RE.test(first.token) ? rows.get(first.token) : undefined
	if (row) {
		if (row.type !== 'user') errors.push(`Queue row ${row.id} must reference a user row.`)
		if (row.truncated) return { cmd: 'queue', id: row.id, type: row.type, row, queueText: String(row.content), line }
		const typePart = splitFirstToken(first.rest)
		if (typePart.token !== 'user') errors.push(`Queue row ${row.id} must use user type.`)
		try {
			const parsed = parseOneAson(typePart.rest)
			if (!parsed || typeof parsed.value !== 'string') errors.push(`Queue row ${row.id} must contain a user string.`)
			return { cmd: 'queue', id: row.id, type: row.type, row, queueText: typeof parsed?.value === 'string' ? parsed.value : '', line }
		} catch (err) {
			errors.push(`Queue row ${row.id} has invalid ASON content: ${err instanceof Error ? err.message : String(err)}`)
			return { cmd: 'queue', id: row.id, type: row.type, row, queueText: '', line }
		}
	}
	const manual = rest.trimStart()
	if (!manual) {
		errors.push('Manual queue messages must be non-empty.')
		return { cmd: 'queue', queueText: '', line }
	}
	if (manual.startsWith('\'') || manual.startsWith('"') || manual.startsWith('`')) {
		try {
			const parsed = parseOneAson(manual)
			if (!parsed || typeof parsed.value !== 'string') errors.push('Quoted queue message must be a string.')
			return { cmd: 'queue', queueText: typeof parsed?.value === 'string' ? parsed.value : '', line }
		} catch (err) {
			errors.push(`Invalid quoted queue message: ${err instanceof Error ? err.message : String(err)}`)
			return { cmd: 'queue', queueText: '', line }
		}
	}
	const text = stripRawComment(manual)
	if (!text) errors.push('Manual queue messages must be non-empty.')
	return { cmd: 'queue', queueText: text, line }
}

function parseTodo(snapshot: RebaseSnapshot, todo: string, opts: ParseTodoOptions = {}): ParsedTodo {
	const errors: string[] = []
	const items: ParsedItem[] = []
	const rows = rowMap(snapshot)
	let sawQueue = false
	let aborted = false
	const seen = new Set<string>()
	const meaningful = todo.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#'))
	if (meaningful.length === 0) return { items: [], errors, aborted: true }
	for (const line of meaningful) {
		const first = splitFirstToken(line)
		const cmd = normalizeCommand(first.token)
		if (!cmd) {
			errors.push(`Unknown command: ${first.token}`)
			continue
		}
		if (cmd === 'abort') {
			aborted = true
			continue
		}
		if (sawQueue && cmd !== 'queue') errors.push('Queue rows must be the final non-comment lines.')
		if (cmd === 'queue') {
			sawQueue = true
			const item = parseQueue(first.rest, rows, line, errors)
			if (item.id) {
				if (seen.has(item.id)) errors.push(`Duplicate id: ${item.id}`)
				seen.add(item.id)
			}
			items.push(item)
			continue
		}
		const idPart = splitFirstToken(first.rest)
		const typePart = splitFirstToken(idPart.rest)
		const row = rows.get(idPart.token)
		if (!row) {
			errors.push(`Unknown id: ${idPart.token}`)
			continue
		}
		if (seen.has(row.id)) errors.push(`Duplicate id: ${row.id}`)
		seen.add(row.id)
		if (typePart.token !== row.type) errors.push(`Type mismatch for ${row.id}: expected ${row.type}`)
		let content: unknown = row.content
		if (!row.truncated) {
			try {
				const parsed = parseOneAson(typePart.rest)
				if (!parsed) errors.push(`Missing content for ${row.id}`)
				else content = parsed.value
			} catch (err) {
				errors.push(`Invalid ASON content for ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
		if (cmd === 'edit' && row.editable && typeof opts.edits?.[row.id] === 'string') content = opts.edits[row.id]
		if (cmd === 'edit' && !row.editable && row.type !== 'thinking') errors.push(`Cannot edit protected row ${row.id}`)
		if (!row.editable && row.type !== 'thinking' && !row.truncated && ason.stringify(content, 'short') !== ason.stringify(row.content, 'short')) errors.push(`Cannot edit protected row ${row.id}`)
		items.push({ cmd, id: row.id, type: row.type, row, content, line })
	}
	return { items, errors, aborted }
}

function flushToolGroup(out: HistoryEntry[], group: ParsedItem[]): void {
	if (group.length === 0) return
	const calls: HistoryEntry[] = []
	const results: HistoryEntry[] = []
	for (const item of group) {
		for (const entry of item.row?.entries ?? []) {
			if (entry.type === 'tool_call') calls.push(cloneEntry(entry))
			else if (entry.type === 'tool_result') results.push(cloneEntry(entry))
		}
	}
	if (calls.length === 0) return
	out.push(...calls, ...results)
}

async function applyParsed(snapshot: RebaseSnapshot, parsed: ParsedTodo): Promise<ApplyResult> {
	if (parsed.errors.length > 0) throw new Error(parsed.errors.join('\n'))
	const entries: HistoryEntry[] = []
	const queue: string[] = []
	let toolGroup: ParsedItem[] = []
	function flush(): void {
		flushToolGroup(entries, toolGroup)
		toolGroup = []
	}
	for (const item of parsed.items) {
		if (item.cmd === 'drop') {
			flush()
			continue
		}
		if (item.cmd === 'queue') {
			flush()
			if (item.queueText?.trim()) queue.push(item.queueText)
			continue
		}
		const row = item.row
		if (!row) continue
		if (row.type === 'tool') {
			toolGroup.push(item)
			continue
		}
		flush()
		const original = row.entries[0]
		if (!original) continue
		const next = cloneEntry(original)
		if (row.editable && typeof item.content === 'string' && item.content !== row.content) {
			if (next.type === 'user') next.parts = (await attachments.resolve(snapshot.sessionId, item.content)).logParts
			if (next.type === 'assistant') next.text = item.content
		}
		entries.push(next)
	}
	flush()
	return { entries, queue }
}

export const rebase = {
	buildSnapshot,
	renderTodo,
	editTexts,
	renderRow,
	parseTodo,
	applyParsed,
	nextHistoryLog,
}

export type { RebaseSnapshot, RebaseRow, ParsedTodo, ParsedItem, ApplyResult }
