// OAuth for HTTP MCP servers (task sxf), as the MCP authorization spec
// describes: protected-resource and authorization-server discovery,
// dynamic client registration, a PKCE browser login with a loopback
// redirect, and refresh. Tokens live in secrets/mcp-oauth.ason, keyed by
// server name and only used for the URL they were issued for.

import { paths } from './paths.ts'
import { secrets } from './secrets.ts'

type Token = {
	url: string
	clientId: string
	clientSecret?: string
	tokenUrl: string
	resource: string
	accessToken: string
	refreshToken?: string
	expires?: number
}
type Metadata = { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string }

const timeoutMs = 15 * 60_000

function store(): Record<string, Token> {
	return (mcpOauth.state.file ??= secrets.file(`${paths.secretsDir()}/mcp-oauth.ason`, {} as Record<string, Token>))
}

const base64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')

// The first candidate URL that answers JSON.
async function firstJson(urls: string[]): Promise<any> {
	for (let url of urls) {
		let res = await fetch(url, { headers: { Accept: 'application/json' } }).catch(() => undefined)
		if (res?.ok) return res.json()
	}
	return undefined
}

// The server's resource, scopes and authorization server metadata.
async function discover(url: string): Promise<{ resource: string; scope?: string; meta: Metadata }> {
	let u = new URL(url)
	let probe = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
	})
	await probe.body?.cancel()
	let hinted = probe.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)?.[1]
	let path = u.pathname.replace(/\/$/, '')
	let prm = await mcpOauth.firstJson(
		hinted
			? [hinted]
			: [`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`],
	)
	let issuer = new URL(prm?.authorization_servers?.[0] ?? u.origin)
	let ipath = issuer.pathname.replace(/\/$/, '')
	let meta = await mcpOauth.firstJson([
		`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`,
		`${issuer.origin}/.well-known/openid-configuration${ipath}`,
		`${issuer.origin}${ipath}/.well-known/openid-configuration`,
	])
	if (!meta?.authorization_endpoint || !meta?.token_endpoint)
		throw new Error(`no OAuth authorization server metadata found for ${url} (issuer ${issuer})`)
	return { resource: prm?.resource ?? url, scope: prm?.scopes_supported?.join(' '), meta }
}

async function post(url: string, body: Record<string, string | undefined>, what: string): Promise<any> {
	let form = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Record<string, string>
	let res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams(form),
	})
	let text = await res.text()
	if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}: ${text}`)
	return JSON.parse(text)
}

function save(name: string, base: Omit<Token, 'accessToken' | 'refreshToken' | 'expires'>, body: any): Token {
	if (typeof body?.access_token !== 'string') throw new Error(`${name}: no access token in the OAuth response`)
	let token: Token = {
		...base,
		accessToken: body.access_token,
		...(typeof body.refresh_token === 'string' && { refreshToken: body.refresh_token }),
		...(typeof body.expires_in === 'number' && { expires: Date.now() + body.expires_in * 1000 }),
	}
	mcpOauth.store()[name] = token
	return token
}

// Dynamic client registration (RFC 7591) as a public client.
async function register(url: string, redirect: string, name: string): Promise<any> {
	let res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({
			client_name: 'Hal',
			redirect_uris: [redirect],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		}),
	})
	let text = await res.text()
	if (!res.ok) throw new Error(`${name} client registration failed: HTTP ${res.status}: ${text}`)
	let client = JSON.parse(text)
	if (typeof client?.client_id !== 'string')
		throw new Error(`${name} client registration returned no client_id: ${text}`)
	return client
}

// The browser login; `say` shows the URL to open.
async function login(name: string, url: string, say: (text: string) => void): Promise<void> {
	let { resource, scope, meta } = await mcpOauth.discover(url)
	if (!meta.registration_endpoint) throw new Error(`${name}: its OAuth server offers no client registration`)
	let verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
	let state = base64url(crypto.getRandomValues(new Uint8Array(32)))
	let challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
	let done!: (code: string) => void, fail!: (e: Error) => void
	let got = new Promise<string>((a, b) => ((done = a), (fail = b)))
	let server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(req) {
			let u = new URL(req.url)
			if (u.pathname !== '/callback') return new Response('Not found', { status: 404 })
			if (u.searchParams.get('state') !== state)
				return new Response(`This login link is stale; run /mcp login ${name} again.`, { status: 400 })
			let code = u.searchParams.get('code')
			if (!code) {
				let error = [u.searchParams.get('error'), u.searchParams.get('error_description')].filter(Boolean).join(': ')
				fail(new Error(`${name} login failed: ${error || 'no code in the redirect'}`))
				return new Response(`${name} login failed; see Hal.`, { status: 400 })
			}
			done(code)
			return new Response(`Signed in to ${name}. You can close this tab and go back to Hal.`)
		},
	})
	let timer = setTimeout(() => fail(new Error(`${name} login timed out after 15 minutes`)), timeoutMs)
	try {
		let redirect = `http://127.0.0.1:${server.port}/callback`
		let client = await mcpOauth.register(meta.registration_endpoint, redirect, name)
		let authorize = new URL(meta.authorization_endpoint)
		let params: Record<string, string | undefined> = {
			response_type: 'code',
			client_id: client.client_id,
			redirect_uri: redirect,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state,
			resource,
			scope,
		}
		for (let [k, v] of Object.entries(params)) if (v !== undefined) authorize.searchParams.set(k, v)
		say(`Open this URL in a browser on this computer to log in to ${name} (it waits up to 15 minutes):\n\n${authorize}`)
		let code = await got
		let base = {
			url,
			clientId: client.client_id,
			...(client.client_secret && { clientSecret: client.client_secret }),
			tokenUrl: meta.token_endpoint,
			resource,
		}
		let body = await mcpOauth.post(
			meta.token_endpoint,
			{
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirect,
				client_id: base.clientId,
				client_secret: base.clientSecret,
				code_verifier: verifier,
				resource,
			},
			`${name} token exchange`,
		)
		mcpOauth.save(name, base, body)
	} finally {
		clearTimeout(timer)
		server.stop(true)
	}
}

async function refresh(name: string, t: Token): Promise<Token> {
	let body = await mcpOauth.post(
		t.tokenUrl,
		{
			grant_type: 'refresh_token',
			refresh_token: t.refreshToken,
			client_id: t.clientId,
			client_secret: t.clientSecret,
			resource: t.resource,
		},
		`${name} token refresh (run /mcp login ${name} if it persists)`,
	)
	let { accessToken: _, refreshToken, expires: __, ...base } = t
	let next = mcpOauth.save(name, base, body)
	if (!next.refreshToken && refreshToken) mcpOauth.store()[name] = { ...next, refreshToken }
	return mcpOauth.store()[name]!
}

// The bearer token for `name` at `url`, refreshed when expiring or when
// `stale` (the server answered 401); undefined when not logged in.
async function token(name: string, url: string, stale = false): Promise<string | undefined> {
	let t = mcpOauth.store()[name]
	if (!t || t.url !== url) return undefined
	let expiring = t.expires !== undefined && t.expires < Date.now() + 60_000
	if ((stale || expiring) && t.refreshToken) {
		let running = mcpOauth.state.refreshing.get(name) ?? mcpOauth.refresh(name, t)
		mcpOauth.state.refreshing.set(name, running)
		t = await running.finally(() => mcpOauth.state.refreshing.delete(name))
	}
	return t.accessToken
}

export const mcpOauth = {
	state: {
		file: undefined as Record<string, Token> | undefined,
		refreshing: new Map<string, Promise<Token>>(),
	},
	store,
	firstJson,
	discover,
	post,
	save,
	register,
	login,
	refresh,
	token,
}
