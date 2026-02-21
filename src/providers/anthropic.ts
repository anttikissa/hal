import type { Provider, StreamEvent, ToolDef } from '../provider.ts'
import { getProviderAuth, updateProviderAuth } from '../auth.ts'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

async function doRefresh(): Promise<void> {
	const auth = getProviderAuth('anthropic')
	if (!auth?.refreshToken) return
	if (Date.now() < auth.expires) return

	const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'refresh_token',
			refresh_token: auth.refreshToken,
			client_id: CLIENT_ID,
		}),
	})
	const data = (await res.json()) as any
	if (!data.access_token) {
		throw new Error(`Anthropic token refresh failed: ${JSON.stringify(data)}`)
	}
	updateProviderAuth('anthropic', {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000,
	})
}

export const anthropicProvider: Provider = {
	name: 'anthropic',
	apiUrl: 'https://api.anthropic.com/v1/messages?beta=true',

	async refreshAuth() {
		await doRefresh()
	},

	getHeaders() {
		const auth = getProviderAuth('anthropic')
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${auth?.accessToken ?? ''}`,
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'oauth-2025-04-20',
			'user-agent': 'hal-claude/0.1.0',
		}
	},

	buildRequestBody({ model, messages, system, tools, maxTokens }) {
		const isAdaptive = /^claude-(opus|sonnet)-4-6/.test(model)
		const body: any = {
			model,
			max_tokens: maxTokens,
			stream: true,
			system,
			tools,
			messages,
			thinking: isAdaptive
				? { type: 'adaptive' }
				: { type: 'enabled', budget_tokens: Math.min(10000, maxTokens - 1) },
		}
		return body
	},

	parseSSE(rawEvent: { type: string; data: string }): StreamEvent[] {
		let event: any
		try {
			event = JSON.parse(rawEvent.data)
		} catch {
			return []
		}

		if (event.type === 'message_start') {
			if (event.message?.usage) return [{ type: 'usage', usage: event.message.usage }]
			return []
		}

		if (event.type === 'content_block_start') {
			const block = event.content_block
			const idx = event.index
			if (block.type === 'thinking') return [{ type: 'thinking_start', index: idx }]
			if (block.type === 'text') return [{ type: 'text_start', index: idx }]
			if (block.type === 'tool_use')
				return [{ type: 'tool_use_start', index: idx, id: block.id, name: block.name }]
			if (block.type === 'server_tool_use' && block.name === 'web_search') {
				return [{ type: 'raw_block', index: idx, block: { ...block } }]
			}
			if (block.type === 'web_search_tool_result') {
				const results = (block.content || [])
					.filter((r: any) => r.type === 'web_search_result')
					.map((r: any, i: number) => `${i + 1}. ${r.title} - ${r.url}`)
					.join('\n')
				const events: StreamEvent[] = [
					{ type: 'raw_block', index: idx, block: { ...block } },
				]
				if (results) events.push({ type: 'web_search_results', results })
				return events
			}
			return []
		}

		if (event.type === 'content_block_delta') {
			const delta = event.delta
			const idx = event.index
			if (delta.type === 'thinking_delta')
				return [{ type: 'thinking_delta', index: idx, text: delta.thinking }]
			if (delta.type === 'text_delta')
				return [{ type: 'text_delta', index: idx, text: delta.text }]
			if (delta.type === 'input_json_delta')
				return [{ type: 'tool_input_delta', index: idx, json: delta.partial_json }]
			if (delta.type === 'signature_delta')
				return [{ type: 'signature_delta', index: idx, signature: delta.signature }]
		}

		if (event.type === 'content_block_stop') {
			return [{ type: 'block_stop', index: event.index }]
		}

		if (event.type === 'message_delta') {
			const events: StreamEvent[] = []
			if (event.delta?.stop_reason)
				events.push({ type: 'stop', stopReason: event.delta.stop_reason })
			if (event.usage) events.push({ type: 'usage', usage: event.usage })
			return events
		}

		return []
	},

	finalizeBlocks(blocks: any[]): any[] {
		for (const block of blocks) {
			if (!block) continue
			if (block.type === 'tool_use' && typeof block.input === 'string') {
				try {
					block.input = JSON.parse(block.input)
				} catch {
					block.input = {}
				}
			}
		}
		return blocks
	},

	addCacheBreakpoints(msgs: any[]): any[] {
		if (msgs.length === 0) return msgs
		const cloned = structuredClone(msgs)

		const addBreakpoint = (msg: any) => {
			if (typeof msg.content === 'string') {
				msg.content = [
					{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
				]
			} else if (Array.isArray(msg.content) && msg.content.length > 0) {
				msg.content[msg.content.length - 1].cache_control = { type: 'ephemeral' }
			}
		}

		addBreakpoint(cloned[cloned.length - 1])
		if (cloned.length >= 3) {
			for (let i = cloned.length - 2; i >= 0; i--) {
				if (cloned[i].role === 'user') {
					addBreakpoint(cloned[i])
					break
				}
			}
		}
		return cloned
	},

	toolResultMessage(toolUseId: string, content: string) {
		return {
			role: 'user',
			content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
		}
	},

	normalizeUsage(usage: Record<string, number>) {
		return {
			input: usage.input_tokens ?? 0,
			output: usage.output_tokens ?? 0,
			cacheCreate: usage.cache_creation_input_tokens ?? 0,
			cacheRead: usage.cache_read_input_tokens ?? 0,
		}
	},

	async complete({ model, system, userMessage, maxTokens }) {
		await doRefresh()
		const res = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
			method: 'POST',
			headers: this.getHeaders(),
			body: JSON.stringify({
				model,
				max_tokens: maxTokens,
				system: [{ type: 'text', text: system }],
				messages: [{ role: 'user', content: userMessage }],
			}),
		})
		const data = (await res.json()) as any
		if (data.error) return { text: '', error: data.error.message }
		const text = data.content?.find((b: any) => b.type === 'text')?.text || 'No response.'
		return { text }
	},
}
