// Context compaction — strip old heavy content (tool results, images, thinking) from API messages.
// Images and tool results cleared after HEAVY_THRESHOLD turns; thinking after THINKING_THRESHOLD.

const HEAVY_THRESHOLD = 4
const THINKING_THRESHOLD = 10

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
	if (lastToolIdx === -1) return stripOldThinking(stripOldImages(msgs))

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
	if (userTurns > HEAVY_THRESHOLD) keepIds.clear()

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

	return stripOldThinking(stripOldImages(out))
}

function hasToolUse(msg: any): boolean {
	return Array.isArray(msg.content) && msg.content.some((b: any) => b.type === 'tool_use')
}

/** Clear image blocks except those in the last N user turns. */
function stripOldImages(msgs: any[]): any[] {
	// Count all user turns to determine recency
	let userCount = 0
	for (const msg of msgs) {
		if (msg.role === 'user') userCount++
	}

	// Walk messages, tracking which user turn we're on
	const out: any[] = []
	let userIdx = 0
	for (const msg of msgs) {
		if (msg.role === 'user') {
			const turnsAgo = userCount - userIdx
			userIdx++
			if (Array.isArray(msg.content) && turnsAgo > HEAVY_THRESHOLD) {
				const content = msg.content.map((b: any) => {
					if (b.type === 'image') {
						const placeholder = b._ref ? `[image cleared — ref: ${b._ref}]` : '[image cleared]'
						return { type: 'text', text: placeholder }
					}
					// Strip images inside tool_result content
					if (b.type === 'tool_result' && Array.isArray(b.content)) {
						return { ...b, content: b.content.map((c: any) =>
							c.type === 'image' ? { type: 'text', text: '[image cleared]' } : c
						)}
					}
					return b
				})
				out.push({ ...msg, content })
				continue
			}
		}
		out.push(msg)
	}
	return out
}
/** Drop thinking blocks from assistant messages older than N user turns. */
function stripOldThinking(msgs: any[]): any[] {
	let userCount = 0
	for (const msg of msgs) {
		if (msg.role === 'user') userCount++
	}

	const out: any[] = []
	let userIdx = 0
	for (const msg of msgs) {
		if (msg.role === 'user') userIdx++
		if (msg.role === 'assistant' && Array.isArray(msg.content)) {
			const turnsAgo = userCount - userIdx
			if (turnsAgo > THINKING_THRESHOLD) {
				const content = msg.content.filter((b: any) => b.type !== 'thinking')
				out.push({ ...msg, content })
				continue
			}
		}
		out.push(msg)
	}
	return out
}
