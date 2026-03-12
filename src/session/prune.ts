// Context pruning — strip old heavy content (tool results, images, thinking) from API messages.
//
// A "turn" = a completed agent response (assistant message without tool_use).
// Tool results and images are cleared after config.heavyThreshold completed turns;
// thinking blocks after config.thinkingThreshold completed turns.
// After a model change, detectPruneOpts temporarily uses config.modelChangeThreshold
// as the heavy-content threshold so the new model gets a slightly longer recent window.

export const pruneConfig = {
	heavyThreshold: 4,
	thinkingThreshold: 10,
	// Used by detectPruneOpts after a session model-change event to keep heavy content longer.
	modelChangeThreshold: 10,
}

export interface PruneOpts {
	heavyThreshold?: number
	thinkingThreshold?: number
}

/** True if this message ends a turn (final assistant response, no tool_use). */
function isTurnEnd(msg: any): boolean {
	if (msg.role !== 'assistant') return false
	if (!Array.isArray(msg.content)) return true
	return !msg.content.some((b: any) => b.type === 'tool_use')
}

function blobRef(block: any): string {
	if (typeof block?._blobId === 'string' && block._blobId) return block._blobId
	if (typeof block?.blobId === 'string' && block.blobId) return block.blobId
	return ''
}

function imageOmittedText(block: any): string {
	const ref = blobRef(block)
	const file = typeof block?._originalFile === 'string' && block._originalFile
		? block._originalFile
		: typeof block?.originalFile === 'string' && block.originalFile
			? block.originalFile
			: ''
	if (ref && file) return `[image omitted from context — blob ${ref}; file ${file}; use read_blob if needed]`
	if (ref) return `[image omitted from context — blob ${ref}; use read_blob if needed]`
	return '[image omitted from context]'
}
/** Strip old tool results, tool inputs, images, and thinking from API messages. */
export function pruneApiMessages(msgs: any[], opts?: PruneOpts): any[] {
	const heavy = opts?.heavyThreshold ?? pruneConfig.heavyThreshold
	const thinking = opts?.thinkingThreshold ?? pruneConfig.thinkingThreshold

	// Precompute: completed turns strictly after each position
	const age = new Array(msgs.length).fill(0)
	let count = 0
	for (let i = msgs.length - 1; i >= 0; i--) {
		age[i] = count
		if (isTurnEnd(msgs[i])) count++
	}

	// Find last tool batch; keep its IDs only if fresh enough
	const keepIds = new Set<string>()
	for (let i = msgs.length - 1; i >= 0; i--) {
		const msg = msgs[i]
		if (msg.role === 'assistant' && Array.isArray(msg.content) &&
			msg.content.some((b: any) => b.type === 'tool_use')) {
			if (age[i] <= heavy) {
				for (const b of msg.content) {
					if (b.type === 'tool_use') keepIds.add(b.id)
				}
			}
			break
		}
	}

	// Single pass: clear heavy content
	const out: any[] = []
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i]

		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			let content = msg.content.map((b: any) => {
				if (b.type === 'tool_use' && !keepIds.has(b.id)) return { ...b, input: {} }
				return b
			})
			if (age[i] > thinking) {
				content = content.filter((b: any) => b.type !== 'thinking')
			}
			out.push({ ...msg, content })
		} else if (msg.role === 'user' && Array.isArray(msg.content)) {
			const content = msg.content.map((b: any) => {
				if (b.type === 'tool_result' && !keepIds.has(b.tool_use_id)) {
					const ref = blobRef(b)
					const content = ref
						? `[tool result omitted from context — blob ${ref}; use read_blob if needed]`
						: '[tool result omitted from context]'
					return { ...b, content }
				}
				if (age[i] > heavy && b.type === 'image') {
					return { type: 'text', text: imageOmittedText(b) }
				}
				return b
			})
			out.push({ ...msg, content })
		} else {
			out.push(msg)
		}
	}

	return out
}

// After a model change, keep more context un-pruned so the new model sees recent history
export function detectPruneOpts(entries: any[]): PruneOpts | undefined {
	let lastModelChangeIdx = -1
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any
		if (e.type === 'session' && e.action === 'model-change') {
			lastModelChangeIdx = i
			break
		}
	}
	if (lastModelChangeIdx < 0) return undefined
	let turnsAfter = 0
	for (let i = lastModelChangeIdx + 1; i < entries.length; i++) {
		const e = entries[i] as any
		if (e.role === 'assistant' && !e.tools) turnsAfter++
	}
	const threshold = pruneConfig.modelChangeThreshold
	if (turnsAfter <= threshold) return { heavyThreshold: threshold }
	return undefined
}

export const prune = { config: pruneConfig, pruneApiMessages, detectPruneOpts }
