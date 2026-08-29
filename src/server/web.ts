// Local web transport. Browser assets are bundled lazily, so normal startup
// does not pay for the web client.

import type { Command } from '../common/protocol.ts'
import type { ClientBootstrap, ClientSessionSnapshot } from '../common/snapshots.ts'
import type { WebClientMessage, WebServerMessage } from '../common/web.ts'
import { webProtocol } from '../common/web.ts'
import { historyIds } from '../common/history-ids.ts'
import { blob } from './session/blob.ts'
import { ipc } from './file-ipc.ts'
import { runtime } from './runtime.ts'
import { sessions } from './sessions.ts'
import { serverKeys, type WebToken } from './server-keys.ts'
import { webUpload } from './web-upload.ts'

type SocketData = {
	ip: string
	token?: string
}

const state: {
	port: number
	server: Bun.Server<SocketData> | null
} = {
	port: 0,
	server: null,
}

function pageHtml(): Promise<string> {
	return Bun.file(`${import.meta.dir}/../web-client/index.html`).text()
}

// Exit code the `hal` wrapper watches for: "restart me so it can git pull first".
// Anything else is a real crash and just exits.
const UPDATE_EXIT_CODE = 42

function gitProc(args: string[]): Bun.Subprocess<"ignore", "pipe", "ignore"> {
	return Bun.spawn(['git', ...args], {
		cwd: `${import.meta.dir}/../..`,
		stdout: 'pipe',
		stderr: 'ignore',
		// A deploy-time git must never sit waiting for credentials it cannot enter.
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	})
}

async function runGit(args: string[]): Promise<number> {
	return await gitProc(args).exited
}

async function gitOut(args: string[]): Promise<string | null> {
	const proc = gitProc(args)
	const stdout = await new Response(proc.stdout).text()
	return (await proc.exited) === 0 ? stdout.trim() : null
}

/**
 * Self-update hook: CI calls this after tests pass. Exiting makes the wrapper
 * pull and relaunch us. With no UPDATE_TOKEN configured (the normal local case)
 * every request is rejected, so the endpoint only exists where it was armed.
 */
async function handleUpdateRequest(request: Request): Promise<Response> {
	if (request.method !== 'POST') return new Response('Not found', { status: 404 })
	const expected = process.env.UPDATE_TOKEN
	if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
		return new Response('Unauthorized', { status: 401 })
	}
	// Restarting drops live sessions for a moment, so only do it when origin
	// actually has something new: editing and pushing from the server itself
	// must not restart a hal that already runs the newest commit. Dispatch
	// through `web` so tests (and eval) can stub the git helpers.
	if ((await web.runGit(['fetch', 'origin', '--quiet'])) !== 0) {
		return new Response('git fetch failed; keeping current process\n', { status: 500 })
	}
	const head = await web.gitOut(['rev-parse', 'HEAD'])
	const upstream = await web.gitOut(['rev-parse', '@{u}'])
	if (head !== null && head === upstream) return new Response('Already up to date\n')
	setTimeout(() => process.exit(UPDATE_EXIT_CODE), 100)
	return new Response('Updating\n')
}

function styleCss(): Promise<string> {
	return Bun.file(`${import.meta.dir}/../web-client/styles.css`).text()
}

const appAssets: Record<string, [file: string, type: string]> = {
	'/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
	'/icon.svg': ['icon.svg', 'image/svg+xml'],
	'/icons/icon-180.png': ['icons/icon-180.png', 'image/png'],
	'/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
	'/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
}

function appAsset(pathname: string): Response | null {
	const asset = web.appAssets[pathname]
	if (!asset) return null
	return new Response(Bun.file(`${import.meta.dir}/../web-client/${asset[0]}`), { headers: { 'content-type': asset[1], 'cache-control': 'no-store' } })
}

function sessionSnapshot(sessionId: string): ClientSessionSnapshot | null {
	const session = ipc.readState().sessions.find((item) => item.id === sessionId)
	const meta = sessions.loadSessionMeta(sessionId)
	if (!session || !meta) return null
	const history = sessions.loadAllHistoryWithOrigin(sessionId)
	return {
		session,
		meta,
		history: hydrateHistory(sessionId, history.entries),
		parentCount: history.parentCount,
		parentId: history.parentId,
		live: sessions.loadLive(sessionId).blocks,
	}
}

function hydrateHistory(sessionId: string, history: ReturnType<typeof sessions.loadAllHistory>): ReturnType<typeof sessions.loadAllHistory> {
	return history.map((entry) => {
		if (entry.type !== 'tool_result' || entry.output !== undefined || !entry.blobId) return entry
		const output = blob.readBlobFromChain(sessionId, entry.blobId)?.result?.content
		return typeof output === 'string' ? { ...entry, output } : entry
	})
}

function bootstrap(): ClientBootstrap {
	const shared = ipc.readState()
	const snapshots: ClientSessionSnapshot[] = []
	for (const session of shared.sessions) {
		const snapshot = web.sessionSnapshot(session.id)
		if (snapshot) snapshots.push(snapshot)
	}
	return { state: shared, metas: sessions.loadAllSessionMetas(), snapshots }
}

function isObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string'
}

function validBaseCommand(value: Record<string, any>): boolean {
	return optionalString(value.sessionId) && optionalString(value.createdAt)
}

function parseCommand(value: unknown): Command | null {
	if (!isObject(value) || typeof value.type !== 'string' || !validBaseCommand(value)) return null
	const text = typeof value.text === 'string' && value.text.length <= 100_000
	const request = typeof value.requestId === 'string' && value.requestId.length <= 1_000
	const question = typeof value.questionId === 'string' && value.questionId.length <= 1_000
	switch (value.type) {
		case 'prompt':
			return text && historyIds.isValid(value.id) && optionalString(value.displayText) && optionalString(value.source) && (value.queue === undefined || typeof value.queue === 'boolean') && (value.sourceTab === undefined || Number.isInteger(value.sourceTab)) ? value as Command : null
		case 'prompt-amend':
			return text && optionalString(value.displayText) && optionalString(value.source) ? value as Command : null
		case 'continue':
		case 'run-next-from-queue':
		case 'pause-before-tools':
		case 'close':
		case 'reset':
		case 'compact':
		case 'focus':
		case 'draft-saved':
			return value as Command
		case 'open':
			return optionalString(value.cwd) && optionalString(value.forkSessionId) && optionalString(value.afterSessionId) && (value.forceNew === undefined || typeof value.forceNew === 'boolean') ? value as Command : null
		case 'resume':
			return optionalString(value.selector) ? value as Command : null
		case 'abort':
			return optionalString(value.abortText) ? value as Command : null
		case 'move':
			return Number.isInteger(value.position) ? value as Command : null
		case 'what':
			return optionalString(value.target) ? value as Command : null
		case 'answer': {
			const answer = value.value
			if (!question || !isObject(answer) || typeof answer.kind !== 'string') return null
			if (answer.kind === 'aborted') return value as Command
			if (answer.kind === 'choice' && typeof answer.choiceId === 'string' && answer.choiceId.length <= 1_000) return value as Command
			if (answer.kind === 'text' && typeof answer.text === 'string' && answer.text.length <= 100_000) return value as Command
			if (answer.kind === 'secret' && typeof answer.ciphertext === 'string' && answer.ciphertext.length <= 5_586) return value as Command
			return null
		}
		case 'rebase-start':
			return request && Number.isInteger(value.clientPid) ? value as Command : null
		case 'rebase-apply':
			return request && Number.isInteger(value.clientPid) && typeof value.todo === 'string' && (value.edits === undefined || isObject(value.edits)) ? value as Command : null
		case 'spawn': {
			const spawn = value.spawn
			return isObject(spawn) && typeof spawn.task === 'string' && ['subagent', 'subagent-leave-open', 'interactive'].includes(spawn.kind) && ['fork', 'fresh'].includes(spawn.mode) && optionalString(spawn.model) && optionalString(spawn.cwd) && optionalString(spawn.name) && optionalString(spawn.childSessionId) ? value as Command : null
		}
		case 'client-status':
			return Number.isInteger(value.pid) && typeof value.startedAt === 'string' && typeof value.updatedAt === 'string' && typeof value.versionStatus === 'string' && optionalString(value.cwd) && optionalString(value.version) && optionalString(value.error) ? value as Command : null
		case 'client-exit':
			return Number.isInteger(value.pid) ? value as Command : null
		default:
			return null
	}
}

function parseClientMessage(text: string): WebClientMessage | null {
	const value = webProtocol.decode(text)
	if (!isObject(value)) return null
	if (value.type === 'authenticate' && typeof value.token === 'string' && value.token) return { type: 'authenticate', token: value.token }
	if (value.type === 'command') {
		const command = web.parseCommand(value.command)
		if (command) return { type: 'command', command }
	}
	return null
}

function encode(message: WebServerMessage): string {
	return webProtocol.encode(message)
}

async function bundleClient(): Promise<string> {
	const { transform } = await import('@dom-expressions/compiler')
	const result = await Bun.build({
		entrypoints: [`${import.meta.dir}/../web-client/main.tsx`],
		target: 'browser',
		minify: true,
		plugins: [{
			name: 'solid-oxc',
			setup(build) {
				build.onLoad({ filter: /\.tsx$/ }, async (args) => {
					const source = await Bun.file(args.path).text()
					return {
						contents: transform(source, { filename: args.path, moduleName: '@solidjs/web', generate: 'dom' }).code,
						loader: 'ts',
					}
				})
			},
		}],
	})
	if (!result.success || !result.outputs[0]) throw new Error(result.logs.map(String).join('\n'))
	return result.outputs[0].text()
}

function nextPort(previousPort: number, tries: number, random = Math.random): number {
	return previousPort + Math.floor((1 + random() * 2) ** tries)
}

function announce(sessionId: string | undefined, port: number): void {
	if (!sessionId) return
	runtime.emitInfo(sessionId, `Web interface available at ${web.urlForToken(serverKeys.ensureLocalToken(), port)}`)
}

function command(args: string): { output?: string; error?: string } {
	const [action = '', ...rest] = args.trim().split(/\s+/)
	if (!action) {
		let tokens = serverKeys.list()
		if (tokens.length === 0) tokens = [serverKeys.ensureLocalToken()]
		const lines = ['Web interface:']
		for (const [index, token] of tokens.entries()) lines.push(`  ${index + 1}. ${web.urlForToken(token)}  · ${token.purpose}`)
		return { output: lines.join('\n') }
	}
	if (action === 'auth') {
		try {
			const token = serverKeys.mint(rest.join(' ') || 'web token')
			return { output: `Web token created (${token.purpose}):\n${web.urlForToken(token)}` }
		} catch (error) {
			return { error: String(error) }
		}
	}
	if (action === 'revoke' && rest.length === 1 && /^\d+$/.test(rest[0]!)) {
		const token = serverKeys.revoke(Number(rest[0]))
		return token ? { output: `Revoked web token ${rest[0]} (${token.purpose}).` } : { error: `No web token ${rest[0]}.` }
	}
	return { error: 'Usage: /web | /web auth [purpose…] | /web revoke <number>' }
}

function urlForToken(token: WebToken, port = state.port): string {
	return `http://localhost:${port}/?auth=${token.token}`
}

function publishSnapshot(server: Bun.Server<SocketData>, sessionId: string): void {
	// Building a snapshot reloads and hydrates the whole session, so skip it entirely
	// when nobody is listening: the host runs this server even with no client attached.
	if (server.subscriberCount('web') === 0) return
	const snapshot = web.sessionSnapshot(sessionId)
	if (snapshot) server.publish('web', web.encode({ type: 'snapshot', snapshot }))
}

function start(port: number, signal: AbortSignal, announcementSessionId?: string): void {
	if (state.server) {
		web.announce(announcementSessionId, state.port)
		return
	}
	serverKeys.init()
	const sockets = new Map<string, Set<Bun.ServerWebSocket<SocketData>>>()
	const unsubscribeRevocation = serverKeys.onRevoke((token) => {
		for (const socket of sockets.get(token.token) ?? []) socket.close(4001, 'Web token revoked')
	})
	let server: Bun.Server<SocketData>
	for (let tries = 1;; tries++) {
		try {
			server = Bun.serve<SocketData>({
				hostname: '127.0.0.1',
				port,
				fetch: async (request, server) => {
					const url = new URL(request.url)
					if (url.pathname === '/api/update') return handleUpdateRequest(request)
					if (url.pathname === '/upload') return webUpload.handleUploadRequest(request, server.requestIP(request)?.address ?? 'unknown')
					const asset = web.appAsset(url.pathname)
					if (asset) return asset
					// `/` and `/<sessionId>` are both the browser app: the client
					// reads the session out of the path so a tab can be linked.
					if (url.pathname === '/' || webProtocol.isSessionPath(url.pathname)) return new Response(await web.pageHtml(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
					if (url.pathname === '/styles.css') return new Response(await web.styleCss(), { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' } })
					if (url.pathname === '/main.js') {
						try { return new Response(await web.bundleClient(), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } }) }
						catch (error) { return new Response(`Web client build failed: ${String(error)}`, { status: 500 }) }
					}
					if (url.pathname === '/ws') {
						if (server.upgrade(request, { data: { ip: server.requestIP(request)?.address ?? 'unknown' } })) return
						return new Response('WebSocket upgrade required', { status: 426 })
					}
					return new Response('Not found', { status: 404 })
				},
				websocket: {
					maxPayloadLength: 1_000_000,
					open() {},
					message(ws, raw) {
						const message = web.parseClientMessage(String(raw))
						if (!message) return
						if (!ws.data.token) {
							if (message.type !== 'authenticate') {
								ws.send(web.encode({ type: 'error', message: 'Web authentication required' }))
								ws.close()
								return
							}
							if (!serverKeys.authenticate(message.token, ws.data.ip)) {
								ws.send(web.encode({ type: 'error', message: 'Invalid authentication token' }))
								ws.close()
								return
							}
							ws.data.token = message.token
							let tokenSockets = sockets.get(message.token)
							if (!tokenSockets) {
								tokenSockets = new Set()
								sockets.set(message.token, tokenSockets)
							}
							tokenSockets.add(ws)
							ws.subscribe('web')
							ws.send(web.encode({ type: 'authenticated', bootstrap: web.bootstrap() }))
							return
						}
						if (message.type === 'command') runtime.handleCommand({ ...message.command, createdAt: new Date().toISOString() })
					},
					close(ws) {
						if (!ws.data.token) return
						const tokenSockets = sockets.get(ws.data.token)
						tokenSockets?.delete(ws)
						if (tokenSockets?.size === 0) sockets.delete(ws.data.token)
					},
				},
			})
			break
		} catch (error: any) {
			if (error?.code !== 'EADDRINUSE' || tries === 10) {
				unsubscribeRevocation()
				throw error
			}
			port = web.nextPort(port, tries)
		}
	}
	state.server = server
	state.port = server.port ?? port
	let openIds = new Set(ipc.readState().sessions.map((session) => session.id))
	const unsubscribeState = ipc.onStateChange((shared) => {
		const nextIds = new Set(shared.sessions.map((session) => session.id))
		for (const sessionId of nextIds) {
			if (!openIds.has(sessionId)) web.publishSnapshot(server, sessionId)
		}
		server.publish('web', web.encode({ type: 'state', state: shared }))
		openIds = nextIds
	})
	void (async () => {
		for await (const event of ipc.tailEvents(signal)) {
			const sessionId = event && typeof event.sessionId === 'string' ? event.sessionId : ''
			if (sessionId && web.isSnapshotBoundary(event) && openIds.has(sessionId)) web.publishSnapshot(server, sessionId)
			server.publish('web', web.encode({ type: 'event', event }))
		}
	})()
	signal.addEventListener('abort', () => {
		unsubscribeRevocation()
		unsubscribeState()
		// Close live sockets too: the server is going away, and remote clients should
		// see the disconnect immediately instead of waiting on a dead connection.
		server.stop(true)
		if (state.server === server) {
			state.server = null
			state.port = 0
		}
	}, { once: true })
	web.announce(announcementSessionId, state.port)
}

function isSnapshotBoundary(event: unknown): boolean {
	if (!isObject(event)) return false
	return event.type === 'stream-end' || event.type === 'history-rebased' || event.type === 'history-updated'
}

export const web = {
	state,
	start,
	command,
	nextPort,
	urlForToken,
	announce,
	pageHtml,
	styleCss,
	appAssets,
	appAsset,
	bundleClient,
	hydrateHistory,
	sessionSnapshot,
	bootstrap,
	parseCommand,
	parseClientMessage,
	uploadDir: () => webUpload.uploadDir(),
	config: webUpload.config,
	saveUpload: (name: string, type: string, data: ArrayBuffer) => webUpload.saveUpload(name, type, data),
	handleUploadRequest: (request: Request, ip: string) => webUpload.handleUploadRequest(request, ip),
	isSnapshotBoundary,
	runGit,
	gitOut,
	handleUpdateRequest,
	encode,
	publishSnapshot,
}
