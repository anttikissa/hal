// Shared fixtures for the OpenAI provider tests: a fake server for both
// OpenAI endpoints and its WebSocket, fake JWTs and keys only.
import { afterEach, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import type { Message, StreamEvent } from '../common/blocks.ts'
import { auth } from './auth.ts'
import { limits } from './limits.ts'
import { openai } from './openai.ts'
import { openaiWs } from './openai-ws.ts'
import { provider } from './provider.ts'
import { usage } from './usage.ts'
import { paths } from './paths.ts'

const savedHome = paths.state.home
const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, SERPER_API_KEY: process.env.SERPER_API_KEY }
const orig = {
	apiUrl: openai.apiUrl,
	codexUrl: openai.codexUrl,
	codexModelsUrl: openai.codexModelsUrl,
	tokenUrl: auth.tokenUrl,
}
export const fake = {
	home: '',
	server: undefined as unknown as ReturnType<typeof Bun.serve>,
	seen: [] as { path: string; headers: Headers; body: any }[],
	reply: (() => new Response()) as () => Response,
	catalogReply: undefined as ((req: Request) => Response) | undefined,
	// WebSocket requests the fake server got; null refuses the upgrade.
	wsSeen: null as any[] | null,
	// Messages the fake socket sends before each response.
	wsBefore: [] as object[],
	wsOutput: [] as object[],
}

export const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`
export const subscriptionToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })
export const sse = (...events: object[]) =>
	new Response(events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
		headers: { 'content-type': 'text/event-stream' },
	})
export const completed = (usage?: object) => ({
	type: 'response.completed',
	response: { status: 'completed', ...(usage && { usage }) },
})
export const writeAuth = (data: object) =>
	writeFileSync(`${fake.home}/secrets/auth.ason`, ason.stringify(data) + '\n', { mode: 0o600 })

// Bodies arrive compressed, as the real APIs take them.
const bodyOf = async (req: Request) => {
	let bytes = new Uint8Array(await req.arrayBuffer())
	let enc = req.headers.get('content-encoding')
	return JSON.parse(
		new TextDecoder().decode(
			enc === 'zstd' ? Bun.zstdDecompressSync(bytes) : enc === 'gzip' ? Bun.gunzipSync(bytes) : bytes,
		),
	)
}

// Starts the fake server before each test and restores everything after.
export function useFakeOpenai(): void {
	beforeEach(() => {
		fake.home = mkdtempSync(`${tmpdir()}/hal-openai-`)
		mkdirSync(`${fake.home}/secrets`)
		paths.state.home = fake.home
		mkdirSync(`${fake.home}/state`)
		delete process.env.OPENAI_API_KEY
		delete process.env.SERPER_API_KEY
		fake.seen = []
		fake.catalogReply = undefined
		fake.reply = () => sse(completed())
		fake.wsSeen = null
		fake.wsBefore = []
		fake.wsOutput = []
		openaiWs.state.enabled = false
		fake.server = Bun.serve({
			port: 0,
			websocket: {
				message(ws, data) {
					let body = JSON.parse(String(data))
					fake.wsSeen!.push(body)
					let id = `resp-${fake.wsSeen!.length}`
					let response = { id, previous_response_id: body.previous_response_id }
					for (let e of [
						...fake.wsBefore,
						{ type: 'response.created', response },
						...fake.wsOutput,
						{ type: 'response.output_text.delta', delta: 'ok' },
						{ type: 'response.completed', response: { ...response, status: 'completed' } },
					])
						ws.send(JSON.stringify(e))
				},
			},
			async fetch(req, srv) {
				let path = new URL(req.url).pathname
				if (req.headers.get('upgrade') === 'websocket')
					return fake.wsSeen && srv.upgrade(req, { data: null })
						? (undefined as unknown as Response)
						: new Response('no', { status: 426 })
				if (path === '/token')
					return Response.json({ access_token: subscriptionToken, refresh_token: 'r2', expires_in: 3600 })
				if (path === '/codex/models') {
					fake.seen.push({ path, headers: req.headers, body: null })
					return (
						fake.catalogReply?.(req) ??
						Response.json({
							models: [
								{ slug: 'gpt-6-sol', visibility: 'list' },
								{ slug: 'gpt-reserve', visibility: 'hide' },
							],
						})
					)
				}
				fake.seen.push({ path, headers: req.headers, body: await bodyOf(req) })
				return fake.reply()
			},
		})
		openai.apiUrl = `http://127.0.0.1:${fake.server.port}/v1/responses`
		openai.codexUrl = `http://127.0.0.1:${fake.server.port}/codex/responses`
		openai.codexModelsUrl = `http://127.0.0.1:${fake.server.port}/codex/models`
		auth.tokenUrl = () => `http://127.0.0.1:${fake.server.port}/token`
		openai.init()
	})

	afterEach(() => {
		auth.close()
		limits.close()
		usage.close()
		fake.server.stop(true)
		Object.assign(openai, { apiUrl: orig.apiUrl, codexUrl: orig.codexUrl, codexModelsUrl: orig.codexModelsUrl })
		auth.tokenUrl = orig.tokenUrl
		provider.state.providers = {}
		for (let id of openaiWs.state.sockets.keys()) openaiWs.close(id)
		openaiWs.state.httpUntil = 0
		openaiWs.state.httpSessions.clear()
		paths.state.home = savedHome
		for (let [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k]
			else process.env[k] = v
		}
		rmSync(fake.home, { recursive: true, force: true })
	})
}

export const hi: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]

export async function run(messages = hi, extra = {}, model = 'openai/gpt-5.5') {
	let out: StreamEvent[] = []
	for await (let e of provider.stream(model, { messages, ...extra })) out.push(e)
	return out
}
