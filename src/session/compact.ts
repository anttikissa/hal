// Context compaction — strip old heavy content (tool results, images, thinking) from API messages.
//
// A "turn" = a completed agent response (assistant message without tool_use).
// Tool results and images are cleared after HEAVY_THRESHOLD completed turns;
// thinking blocks after THINKING_THRESHOLD completed turns.

// Completed turns (assistant final responses) before content is stripped
const HEAVY_THRESHOLD = 4
const THINKING_THRESHOLD = 10

export interface CompactOpts {
	heavyThreshold?: number
}

/** True if this message ends a turn (final assistant response, no tool_use). */
function isTurnEnd(msg: any): boolean {
	if (msg.role !== 'assistant') return false
	if (!Array.isArray(msg.content)) return true
	return !msg.content.some((b: any) => b.type === 'tool_use')
}

/** Strip old tool results, tool inputs, images, and thinking from API messages. */
export function compactApiMessages(msgs: any[], opts?: CompactOpts): any[] {
	const heavy = opts?.heavyThreshold ?? HEAVY_THRESHOLD

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
			if (age[i] > THINKING_THRESHOLD) {
				content = content.filter((b: any) => b.type !== 'thinking')
			}
			out.push({ ...msg, content })
		} else if (msg.role === 'user' && Array.isArray(msg.content)) {
			const content = msg.content.map((b: any) => {
				if (b.type === 'tool_result' && !keepIds.has(b.tool_use_id)) {
					return { ...b, content: `[tool result omitted from context — blob ${b._blobId}; use read_blob if needed]` }
				}
				if (age[i] > heavy && b.type === 'image') {
					return { type: 'text', text: `[image omitted from context — blob ${b._blobId}; use read_blob if needed]` }
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

export const compact = { compactApiMessages }
