import { Provider } from '../provider.ts'
import { getProviderAuth, updateProviderAuth } from '../auth.ts'

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

async function doRefresh(): Promise<void> {
	const auth = getProviderAuth('anthropic')
	if (!auth?.refreshToken) return
	if (Date.now() < (auth.expires ?? 0)) return

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

class AnthropicProvider extends Provider {
	name = 'anthropic'

	async refreshAuth() {
		await doRefresh()
	}

	async fetch(body: any, signal?: AbortSignal) {
		const auth = getProviderAuth('anthropic')
		return fetch('https://api.anthropic.com/v1/messages?beta=true', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${auth?.accessToken ?? ''}`,
				'anthropic-version': '2023-06-01',
				'anthropic-beta': 'oauth-2025-04-20',
				'user-agent': 'hal-claude/0.1.0',
			},
			body: JSON.stringify(body),
			signal,
		})
	}

	buildRequestBody({ model, messages, system, tools, maxTokens }: any) {
		const isAdaptive = /^claude-(opus|sonnet)-4-6/.test(model)
		return {
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
	}

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
	}

	async complete({ model, system, userMessage, maxTokens }: any) {
		await doRefresh()
		const body = {
			model,
			max_tokens: maxTokens,
			system: [{ type: 'text', text: system }],
			messages: [{ role: 'user', content: userMessage }],
		}
		const res = await this.fetch(body)
		const data = (await res.json()) as any
		if (data.error) return { text: '', error: data.error.message }
		const text = data.content?.find((b: any) => b.type === 'text')?.text || 'No response.'
		const truncated = data.stop_reason === 'max_tokens'
		return { text, truncated }
	}
}

export const anthropicProvider = new AnthropicProvider()
