import type { Provider, StreamEvent, ToolDef } from "../provider.ts"
import { getProviderAuth, updateProviderAuth } from "../auth.ts"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
const RESPONSES_API_URL = "https://api.openai.com/v1/responses"
const CODEX_BASE_URL = "https://chatgpt.com/backend-api"

function decodeJwtPayload(token: string): any | null {
	try {
		const parts = token.split(".")
		if (parts.length !== 3) return null
		return JSON.parse(atob(parts[1]))
	} catch { return null }
}

function extractAccountId(token: string): string | null {
	const payload = decodeJwtPayload(token)
	const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id
	return typeof id === "string" && id.length > 0 ? id : null
}

function hasScope(token: string, scope: string): boolean {
	const payload = decodeJwtPayload(token)
	if (!payload) return false
	for (const claim of [payload.scp, payload.scope]) {
		if (Array.isArray(claim) && claim.includes(scope)) return true
		if (typeof claim === "string" && claim.split(/\s+/).includes(scope)) return true
	}
	return false
}

function isApiKey(token: string): boolean {
	return /^sk-[A-Za-z0-9]/.test(token)
}

function resolveApiUrl(token: string): string {
	if (isApiKey(token)) return RESPONSES_API_URL
	if (hasScope(token, "api.responses.write")) return RESPONSES_API_URL
	return `${CODEX_BASE_URL}/codex/responses`
}

function usesCodex(token: string): boolean {
	return resolveApiUrl(token).includes("/codex/responses")
}

function getToken(): string {
	return getProviderAuth("openai")?.accessToken ?? ""
}

async function doRefresh(): Promise<void> {
	const auth = getProviderAuth("openai")
	if (!auth?.refreshToken) return
	if (isApiKey(auth.accessToken)) return
	if (Date.now() < auth.expires - 60_000) return

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: auth.refreshToken,
			client_id: CLIENT_ID,
		}),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => "")
		throw new Error(`OpenAI token refresh failed: ${res.status} ${text}`)
	}
	const data = (await res.json()) as any
	if (!data.access_token) throw new Error("OpenAI token refresh response missing access_token")

	const accountId = extractAccountId(data.access_token)
	updateProviderAuth("openai", {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000,
		...(accountId ? { accountId } : {}),
	})
}

// Message format translation: internal (Anthropic-style) → OpenAI Responses API

function systemToText(system: any[]): string {
	return system.map((s: any) => typeof s === "string" ? s : s.text ?? JSON.stringify(s)).join("\n\n")
}

function convertMessages(messages: any[]): any[] {
	const input: any[] = []
	for (const msg of messages) {
		if (msg.role === "user") {
			if (Array.isArray(msg.content)) {
				const toolResults = msg.content.filter((b: any) => b.type === "tool_result")
				if (toolResults.length > 0) {
					for (const tr of toolResults) {
						input.push({
							type: "function_call_output",
							call_id: tr.tool_use_id,
							output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
						})
					}
					continue
				}
				const parts = msg.content.map((b: any) => {
					if (b.type === "text") return { type: "input_text", text: b.text }
					if (b.type === "image") {
						return {
							type: "input_image",
							detail: "auto",
							image_url: `data:${b.source?.media_type ?? "image/png"};base64,${b.source?.data ?? b.data}`,
						}
					}
					return { type: "input_text", text: JSON.stringify(b) }
				})
				input.push({ role: "user", content: parts })
			} else {
				input.push({ role: "user", content: [{ type: "input_text", text: msg.content }] })
			}
		} else if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text") {
					input.push({
						type: "message", role: "assistant", status: "completed",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
					})
				} else if (block.type === "thinking" && block.thinkingSignature) {
					try { input.push(JSON.parse(block.thinkingSignature)) } catch { /* skip */ }
				} else if (block.type === "tool_use") {
					input.push({
						type: "function_call",
						call_id: block.id,
						name: block.name,
						arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
					})
				}
			}
		}
	}
	return input
}

function convertTools(tools: ToolDef[]): any[] {
	return tools
		.filter(t => !t.type || t.type === "custom")
		.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema }))
}

function extractErrorMessage(payload: any): string {
	if (!payload || typeof payload !== "object") return "unknown"
	for (const path of [payload.message, payload.error?.message, payload.error?.code, payload.code, payload.response?.error?.message]) {
		if (typeof path === "string" && path.trim()) return path
	}
	return "unknown"
}

// Per-stream state
interface StreamState {
	itemMap: Map<number, number>
	nextBlockIndex: number
	toolInputs: Map<number, string>
}

let streamState: StreamState = { itemMap: new Map(), nextBlockIndex: 0, toolInputs: new Map() }
let currentSessionId = ""

export const openaiProvider: Provider = {
	name: "openai",

	get apiUrl() { return resolveApiUrl(getToken()) },

	async refreshAuth() { await doRefresh() },

	getHeaders() {
		const token = getToken()
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			accept: "text/event-stream",
			"User-Agent": "hal-claude/0.1.0",
		}
		if (usesCodex(token)) {
			const accountId = extractAccountId(token) || getProviderAuth("openai")?.accountId || ""
			if (!accountId) throw new Error("OpenAI token missing chatgpt_account_id")
			headers["OpenAI-Beta"] = "responses=experimental"
			headers.originator = "pi"
			headers["chatgpt-account-id"] = accountId
			if (currentSessionId) headers.session_id = currentSessionId
		}
		return headers
	},

	buildRequestBody({ model, messages, system, tools, maxTokens, sessionId }) {
		streamState = { itemMap: new Map(), nextBlockIndex: 0, toolInputs: new Map() }
		if (sessionId) currentSessionId = sessionId

		const codex = usesCodex(getToken())
		const input = convertMessages(messages)
		const openaiTools = convertTools(tools)
		const instructions = systemToText(system)

		const body: any = { model, store: false, stream: true, input }
		if (instructions) body.instructions = instructions

		if (!codex) {
			body.max_output_tokens = maxTokens
		} else {
			body.text = { verbosity: "medium" }
			body.include = ["reasoning.encrypted_content"]
			if (sessionId) body.prompt_cache_key = sessionId
		}

		if (openaiTools.length > 0) {
			body.tools = openaiTools
			body.tool_choice = "auto"
			body.parallel_tool_calls = true
		}

		if (model.startsWith("o")) {
			body.reasoning = { effort: "high", summary: "auto" }
		}

		return body
	},

	parseSSE(rawEvent: { type: string; data: string }): StreamEvent[] {
		let event: any
		try { event = JSON.parse(rawEvent.data) } catch { return [] }
		const type = event.type
		if (!type) return []

		if (type === "response.output_item.added") {
			const item = event.item
			const oi = event.output_index ?? 0
			const bi = streamState.nextBlockIndex++
			streamState.itemMap.set(oi, bi)
			if (item.type === "reasoning") return [{ type: "thinking_start", index: bi }]
			if (item.type === "message") return [{ type: "text_start", index: bi }]
			if (item.type === "function_call") {
				streamState.toolInputs.set(oi, "")
				return [{ type: "tool_use_start", index: bi, id: item.call_id ?? `call_${bi}`, name: item.name ?? "" }]
			}
			return []
		}

		if (type === "response.reasoning_summary_text.delta") {
			const bi = streamState.itemMap.get(event.output_index ?? 0)
			return bi !== undefined ? [{ type: "thinking_delta", index: bi, text: event.delta ?? "" }] : []
		}

		if (type === "response.reasoning_summary_part.done") {
			const bi = streamState.itemMap.get(event.output_index ?? 0)
			return bi !== undefined ? [{ type: "thinking_delta", index: bi, text: "\n\n" }] : []
		}

		if (type === "response.output_text.delta" || type === "response.refusal.delta") {
			const bi = streamState.itemMap.get(event.output_index ?? 0)
			return bi !== undefined ? [{ type: "text_delta", index: bi, text: event.delta ?? "" }] : []
		}

		if (type === "response.function_call_arguments.delta") {
			const oi = event.output_index ?? 0
			const bi = streamState.itemMap.get(oi)
			if (bi !== undefined) {
				const cur = streamState.toolInputs.get(oi) ?? ""
				streamState.toolInputs.set(oi, cur + (event.delta ?? ""))
				return [{ type: "tool_input_delta", index: bi, json: event.delta ?? "" }]
			}
			return []
		}

		if (type === "response.output_item.done") {
			const bi = streamState.itemMap.get(event.output_index ?? 0)
			return bi !== undefined ? [{ type: "block_stop", index: bi }] : []
		}

		if (type === "response.completed") {
			const response = event.response
			const events: StreamEvent[] = []
			if (response?.usage) {
				const cached = response.usage.input_tokens_details?.cached_tokens ?? 0
				events.push({
					type: "usage",
					usage: {
						input_tokens: (response.usage.input_tokens ?? 0) - cached,
						output_tokens: response.usage.output_tokens ?? 0,
						cache_read_input_tokens: cached,
						cache_creation_input_tokens: 0,
					},
				})
			}
			let stopReason = "end_turn"
			const status = response?.status
			if (status === "incomplete") stopReason = "max_tokens"
			else if (status === "failed" || status === "cancelled") stopReason = "error"
			const hasToolCalls = (response?.output ?? []).some((item: any) => item.type === "function_call")
			if (hasToolCalls && stopReason === "end_turn") stopReason = "tool_use"
			events.push({ type: "stop", stopReason })
			return events
		}

		if (type === "error" || type === "response.failed") {
			return [{ type: "error", message: `${type}: ${extractErrorMessage(event)}` }]
		}

		return []
	},

	finalizeBlocks(blocks: any[]): any[] {
		for (const block of blocks) {
			if (!block) continue
			if (block.type === "tool_use" && typeof block.input === "string") {
				try { block.input = JSON.parse(block.input) } catch { block.input = {} }
			}
		}
		return blocks
	},

	addCacheBreakpoints(msgs: any[]): any[] {
		return msgs // OpenAI doesn't use Anthropic-style cache breakpoints
	},

	toolResultMessage(toolUseId: string, content: string) {
		return { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] }
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
		const token = getToken()
		const codex = usesCodex(token)
		const body: any = {
			model,
			input: [{ role: "user", content: [{ type: "input_text", text: userMessage }] }],
			store: false,
		}
		if (!codex) {
			body.instructions = system
			body.max_output_tokens = maxTokens
		} else if (system) {
			body.input.unshift({ role: "system", content: [{ type: "input_text", text: system }] })
		}
		const res = await fetch(this.apiUrl, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(body),
		})
		const data = (await res.json()) as any
		if (data.error) return { text: "", error: data.error?.message ?? JSON.stringify(data.error) }
		const parts: string[] = []
		for (const item of data.output ?? []) {
			if (item.type === "message" && Array.isArray(item.content)) {
				for (const part of item.content) {
					if (part.type === "output_text") parts.push(part.text)
				}
			}
		}
		return { text: parts.join("\n") || "No response." }
	},
}
