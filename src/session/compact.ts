// Context compaction — strip old heavy content from API messages.
// Keeps the last tool batch intact; clears everything older.

const STALE_THRESHOLD = 5

/** Strip old tool results, tool inputs, and images from API messages. */
export function compactApiMessages(msgs: any[]): any[] {
	// 1. Find last assistant message with tool_use blocks
	let lastToolIdx = -1
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i].role === 'assistant' && hasToolUse(msgs[i])) {
			lastToolIdx = i
			break
		}
	}
	if (lastToolIdx === -1) return stripOldImages(msgs)

	// 2. Collect tool IDs from last batch
	const keepIds = new Set<string>()
	for (const b of msgs[lastToolIdx].content) {
		if (b.type === 'tool_use') keepIds.add(b.id)
	}

	// 3. Count plain user turns after the last tool batch
	let userTurns = 0
	for (let i = lastToolIdx + 1; i < msgs.length; i++) {
		if (msgs[i].role === 'user' && typeof msgs[i].content === 'string') userTurns++
	}

	// 4. If too many user turns, the batch is stale — clear it too
	if (userTurns > STALE_THRESHOLD) keepIds.clear()

	// 5. Walk all messages, clear heavy content not in keep set
	const out: any[] = []
	for (const msg of msgs) {
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			const content = msg.content.map((b: any) => {
				if (b.type === 'tool_use' && !keepIds.has(b.id)) {
					return { ...b, input: {} }
				}
				return b
			})
			out.push({ ...msg, content })
		} else if (msg.role === 'user' && Array.isArray(msg.content)) {
			const content = msg.content.map((b: any) => {
				if (b.type === 'tool_result' && !keepIds.has(b.tool_use_id)) {
					const placeholder = b._ref ? `[cleared — ref: ${b._ref}]` : '[cleared]'
					return { ...b, content: placeholder }
				}
				return b
			})
			out.push({ ...msg, content })
		} else {
			out.push(msg)
		}
	}

	return stripOldImages(out)
}

function hasToolUse(msg: any): boolean {
	return Array.isArray(msg.content) && msg.content.some((b: any) => b.type === 'tool_use')
}

/** Clear image blocks except those in the last N user turns. */
function stripOldImages(msgs: any[]): any[] {
	const userIndices: number[] = []
	for (let i = 0; i < msgs.length; i++) {
		if (msgs[i].role === 'user' && Array.isArray(msgs[i].content)) {
			userIndices.push(i)
		}
	}

	// Keep images in last 2 user turns with array content
	const keepFrom = userIndices.length >= 2
		? userIndices[userIndices.length - 2]
		: userIndices[0] ?? msgs.length

	const out: any[] = []
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i]
		if (msg.role === 'user' && Array.isArray(msg.content) && i < keepFrom) {
			const content = msg.content.map((b: any) => {
				if (b.type === 'image') return { type: 'text', text: '[image cleared]' }
				return b
			})
			out.push({ ...msg, content })
		} else {
			out.push(msg)
		}
	}
	return out
}
