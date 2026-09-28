	return `[model ${model} thinking]\n${text}`
}

/** Filter out orphaned web_search blocks. A server_tool_use (web_search) must be
 *  paired with a web_search_tool_result and vice versa — unpaired blocks cause API errors. */
function filterUnpairedWebSearch(blocks: any[]): any[] {
	if (!Array.isArray(blocks) || blocks.length === 0) return blocks
	const useIds = new Set<string>()
	const resultIds = new Set<string>()
	for (const b of blocks) {
		if (b?.type === 'server_tool_use' && b?.name === 'web_search' && typeof b?.id === 'string')
			useIds.add(b.id)
		if (b?.type === 'web_search_tool_result' && typeof b?.tool_use_id === 'string')
			resultIds.add(b.tool_use_id)
	}
	return blocks.filter((b: any) => {
		if (b?.type === 'server_tool_use' && b?.name === 'web_search')
			return typeof b.id === 'string' && resultIds.has(b.id)
		if (b?.type === 'web_search_tool_result')
			return typeof b.tool_use_id === 'string' && useIds.has(b.tool_use_id)
		return true
	})
}

/** Remove or transform blocks Anthropic can't handle. */
function sanitizeMessages(msgs: Message[]): any[] {
	if (!msgs.length) return msgs
	const out: any[] = []
	for (const msg of msgs) {
		if (!Array.isArray(msg.content)) {
			out.push(msg)
			continue
		}
		let content: any[] = []
		for (const block of msg.content as any[]) {
			if (block.type === 'thinking') {
				// Foreign thinking (e.g. OpenAI reasoning) → convert to text
				if (isOpenAIReasoningSignature(block.signature)) {
					const replayed = formatForeignThinking(block.thinking, block._model)
					if (replayed) content.push({ type: 'text', text: replayed })
					continue
				}
				// Native Anthropic thinking — pass through
				content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
				continue
			}
			content.push(block)
		}
		// Drop orphaned web_search blocks (can happen after context compaction or aborted turns)
		content = filterUnpairedWebSearch(content)
		if (content.length > 0) out.push({ ...msg, content })
	}
	return out
}

// ── Prompt caching ──
// Mark the last user message (and second-to-last user message if conversation
// is long enough) with cache_control for Anthropic's prompt caching feature.

function applyCacheBreakpoints(msgs: any[]): any[] {
	if (!msgs.length) return msgs
// ...
		if (ev.type === 'content_block_start') {
			const b = ev.content_block
			if (b.type === 'tool_use') {
				tools.set(ev.index, { id: b.id, name: b.name, json: '', input: b.input })
			} else if (b.type === 'server_tool_use') {
				// Server-side tool input streams as input_json_delta after this empty block.
				serverTools.set(ev.index, { block: b, json: '' })
			} else if (b.type === 'web_search_tool_result') {
				yield { type: 'server_tool', serverBlocks: [b] }
			}
		} else if (ev.type === 'content_block_delta') {
			const d = ev.delta
			if (d.type === 'thinking_delta') yield { type: 'thinking', text: d.thinking }
			else if (d.type === 'signature_delta') yield { type: 'thinking_signature', signature: d.signature }
			else if (d.type === 'text_delta') yield { type: 'text', text: d.text }
			else if (d.type === 'input_json_delta') {
				// Accumulate partial JSON for local and server-side tool input.
				const t = tools.get(ev.index)
				if (t) t.json += d.partial_json
				const st = serverTools.get(ev.index)
				if (st) st.json += d.partial_json
// ...
		body.thinking = isAdaptive
			? { type: 'adaptive' }
			: { type: 'enabled', budget_tokens: Math.min(10000, MAX_TOKENS - 1) }
	}

	if (req.tools?.length) {
		// Append web_search as a server-side tool — Claude searches the web itself,
		// no local execution needed. Results come back as server_tool_use /
		// web_search_tool_result content blocks in the stream.
		body.tools = [
			...req.tools,
			{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
		]
	}

	const url = API_URL
	const halVersion = version.state.combined ? `hal/${version.state.combined}` : 'hal'
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		...(isOAuth ? { Authorization: `Bearer ${cred.value}` } : { 'x-api-key': cred.value }),
		'anthropic-version': API_VERSION,
