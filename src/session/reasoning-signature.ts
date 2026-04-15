// Minimal OpenAI reasoning signatures.
//
// OpenAI's reasoning items can include large summary arrays that duplicate the
// human-readable thinking text we already store separately. For replay we only
// need the encrypted payload, plus the ID so repeated reasoning items can be
// deduplicated.

interface ReasoningItem {
	type: 'reasoning'
	id?: string
	encrypted_content: string
	// Codex backend expects a summary array when replaying reasoning items.
	// We keep it optional because compacted on-disk signatures intentionally
	// drop it to save space, then rehydrate it from the visible thinking text.
	summary?: any[]
}

function fromObject(value: unknown): ReasoningItem | null {
	if (!value || typeof value !== 'object') return null
	const item = value as Record<string, unknown>
	if (item.type !== 'reasoning') return null
	if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) return null
	return {
		type: 'reasoning',
		id: typeof item.id === 'string' && item.id ? item.id : undefined,
		encrypted_content: item.encrypted_content,
		summary: Array.isArray(item.summary) && item.summary.length > 0 ? item.summary : undefined,
	}
}

function parse(signature: unknown): ReasoningItem | null {
	if (typeof signature !== 'string' || !signature.trim()) return null
	try {
		return fromObject(JSON.parse(signature))
	} catch {
		return null
	}
}

function withSummary(signature: unknown, thinking: unknown): ReasoningItem | null {
	const item = typeof signature === 'string' ? parse(signature) : fromObject(signature)
	if (!item) return null
	if (Array.isArray(item.summary) && item.summary.length > 0) return item
	if (typeof thinking !== 'string') return item

	// The stored thinking text is the streamed reasoning summary text, so it is
	// safe to use as a replay summary when a compacted signature omitted it.
	const text = thinking.trim()
	if (!text) return item
	return {
		...item,
		summary: [{ type: 'summary_text', text }],
	}
}

function minimize(signature: unknown): string | null {
	const item = typeof signature === 'string' ? parse(signature) : fromObject(signature)
	if (!item) return null
	return JSON.stringify({
		type: 'reasoning',
		id: item.id,
		encrypted_content: item.encrypted_content,
	})
}

export const reasoningSignature = { parse, withSummary, minimize }
