// Shared setup for the web endpoint tests: a fresh home and a free port
// per test, logins and WebSocket clients.

import { afterEach, beforeEach, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { ason } from '../common/ason.ts'
import { settings } from '../common/settings.ts'
import { pages } from './pages.ts'
import { host } from './host.ts'
import { turns } from './turns.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'

const savedHome = paths.state.home
const origPort = web.port
const origStream = turns.stream
const origBudget = pages.budget
let home = ''
let sockets: WebSocket[] = []

// The home directory of the running test.
export function testHome(): string {
	return home
}

// Registers the hooks that give each test a fresh home and web port.
export function useWeb(): void {
	beforeEach(() => {
		home = mkdtempSync(`${tmpdir()}/hal-web-`)
		paths.state.home = home
		paths.init()
		web.port = () => 0
	})

	afterEach(async () => {
		for (let ws of sockets) ws.close()
		sockets = []
		await server.stop()
		host.reset()
		sessions.closeAll()
		web.port = origPort
		turns.stream = origStream
		pages.budget = origBudget
		if (savedHome === undefined) paths.state.home = undefined
		else paths.state.home = savedHome
		rmSync(home, { recursive: true, force: true })
	})
}

export const base = () => `http://127.0.0.1:${web.state.server!.port}`

export async function login(code: string, headers: Record<string, string> = {}): Promise<Response> {
	let body = new FormData()
	body.set('code', code)
	return fetch(`${base()}/login`, { method: 'POST', body, headers })
}

export async function cookie(): Promise<string> {
	let res = await login(webAuth.issue())
	expect(res.ok).toBe(true)
	return res.headers.get('set-cookie')!.split(';')[0]!
}

export async function until(check: () => unknown): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (check()) return
		await Bun.sleep(2)
	}
	throw new Error('timed out')
}

export async function dial(cookieHeader?: string, query = '', origin = base()) {
	let headers: Record<string, string> = origin ? { origin } : {}
	if (cookieHeader) headers.cookie = cookieHeader
	let ws = new WebSocket(`${base().replace('http', 'ws')}/ws${query}`, { headers } as any)
	sockets.push(ws)
	let events: any[] = []
	ws.onmessage = (m) => events.push(ason.parse(String(m.data)))
	let opened = await new Promise<boolean>((resolve) => {
		ws.onopen = () => resolve(true)
		ws.onerror = () => resolve(false)
	})
	let closed = new Promise<number>((resolve) => ws.addEventListener('close', (e) => resolve(e.code)))
	return { ws, events, opened, closed, send: (c: unknown) => ws.send(ason.stringify(c, 'short')) }
}

// Provider tests select their model explicitly instead of running onboarding.
export function providerHome(): void {
	settings.state.raw = { model: 'anthropic/claude-opus-5-5' }
}
