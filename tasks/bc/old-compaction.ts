const ASSISTANT_TRIM_HEAD_BYTES = 1024
const ASSISTANT_TRIM_TAIL_BYTES = 2048

function utf8Prefix(text: string, limit: number): string {
	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= limit) lo = mid
		else hi = mid - 1
	}
	return text.slice(0, lo)
}

function utf8Suffix(text: string, limit: number): string {
	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.floor((lo + hi) / 2)
		if (Buffer.byteLength(text.slice(mid), 'utf8') <= limit) hi = mid
		else lo = mid + 1
	}
	return text.slice(lo)
}

function formatKb(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024))}kB`
}

function trimAssistantForCompaction(text: string): string {
	const originalBytes = Buffer.byteLength(text, 'utf8')
	const keptBytes = ASSISTANT_TRIM_HEAD_BYTES + ASSISTANT_TRIM_TAIL_BYTES
	if (originalBytes <= keptBytes) return text

	const marker = `[...block of size ${formatKb(originalBytes)} trimmed down to ${formatKb(keptBytes)}...]`
	return `${utf8Prefix(text, ASSISTANT_TRIM_HEAD_BYTES)}${marker}${utf8Suffix(text, ASSISTANT_TRIM_TAIL_BYTES)}`
}

function compactionUserText(entry: HistoryEntry): string {
	if (entry.type !== 'user') return ''
	const text = sessionEntry.userText(entry, { images: 'path-or-blob-or-image' })
	if (!text || text.startsWith('[system]')) return ''
	return text
}

function compactionPreservedIndexes(entries: HistoryEntry[]): Set<number> {
	const preserved = new Set<number>()
	const userIndexes: number[] = []

	for (let i = 0; i < entries.length; i++) {
		if (compactionUserText(entries[i]!)) userIndexes.push(i)
	}
	if (userIndexes.length === 0) return preserved

	const firstUser = userIndexes[0]!
	preserved.add(firstUser)
	for (let i = firstUser + 1; i < entries.length; i++) {
		const entry = entries[i]!
		if (entry.type === 'assistant') {
			preserved.add(i)
			break
		}
	}

	const tailUsers = userIndexes.slice(-3)
	for (const index of tailUsers) preserved.add(index)
	const tailStart = tailUsers[0]
	if (tailStart !== undefined) {
		for (let i = tailStart + 1; i < entries.length; i++) {
			if (entries[i]!.type === 'assistant') preserved.add(i)
		}
	}

	return preserved
}

function addOmissionPart(parts: string[], count: number, singular: string, plural: string): void {
	if (count === 0) return
	if (count === 1) parts.push(`1 ${singular}`)
	else parts.push(`${count} ${plural}`)
}

function compactionOmissionLine(entries: HistoryEntry[], start: number, end: number): string {
	let toolCalls = 0
	let toolResults = 0
	let thinkingBlocks = 0
	let assistantBlocks = 0
	let prompts = 0

	for (let i = start; i <= end; i++) {
		const entry = entries[i]!
		if (entry.type === 'tool_call') toolCalls++
		else if (entry.type === 'tool_result') toolResults++
		else if (entry.type === 'thinking') thinkingBlocks++
		else if (entry.type === 'assistant') assistantBlocks++
		else if (compactionUserText(entry)) prompts++
	}

	const parts: string[] = []
	addOmissionPart(parts, toolCalls, 'tool call', 'tool calls')
	addOmissionPart(parts, toolResults, 'tool result', 'tool results')
	addOmissionPart(parts, thinkingBlocks, 'thinking block', 'thinking blocks')
	addOmissionPart(parts, assistantBlocks, 'assistant block', 'assistant blocks')
	addOmissionPart(parts, prompts, 'prompt', 'prompts')
	if (parts.length === 0) return ''

	const label = start === end ? `${start + 1}` : `${start + 1}-${end + 1}`
	return `[${label}] ${parts.join(', ')} omitted`
}

function addCompactionOmission(lines: string[], entries: HistoryEntry[], start: number | null, end: number): void {
	if (start === null || start > end) return
	const line = compactionOmissionLine(entries, start, end)
	if (line) lines.push(line)
}

function addCompactionEntry(lines: string[], entry: HistoryEntry, index: number): void {
	if (entry.type === 'user') {
		lines.push(`[${index + 1}] user: ${compactionUserText(entry)}`)
		return
	}
	if (entry.type === 'assistant') lines.push(`[${index + 1}] assistant: ${trimAssistantForCompaction(entry.text)}`)
}

function buildCompactionContext(sessionId: string, entries: HistoryEntry[]): string {
	const preserved = compactionPreservedIndexes(entries)
	const dir = sessions.sessionDir(sessionId)
	if (preserved.size === 0) {
		return `Context was compacted. No user prompts in previous conversation. Full history: ${dir}/history*.asonl + blobs/`
	}

	const lines: string[] = [
		'Context was compacted to avoid exceeding the token limit. Verify before assuming.',
		'',
		"Here's summary of what happened (only user and assistant messages preserved):",
		'',
	]

	let omissionStart: number | null = null
	for (let i = 0; i < entries.length; i++) {
		if (preserved.has(i)) {
			addCompactionOmission(lines, entries, omissionStart, i - 1)
			addCompactionEntry(lines, entries[i]!, i)
			omissionStart = null
		} else if (omissionStart === null) {
			omissionStart = i
		}
	}
	addCompactionOmission(lines, entries, omissionStart, entries.length - 1)

	lines.push('')
	lines.push(`Full history: ${dir}/history*.asonl + blobs/`)
	return lines.join('\n')
}

function inputHistoryFromEntries(entries: HistoryEntry[]): string[] {
