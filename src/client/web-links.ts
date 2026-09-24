// Browser destinations for the local terminal and the HTTPS terminal transport.
// Never trust a server-advertised origin to redirect a remote client's token.
import { readFileSync } from 'fs'
import { ason } from '../utils/ason.ts'
import { webProtocol } from '../common/web.ts'
import { historyIds } from '../common/history-ids.ts'
import { clientBackend } from './backend.ts'
import { client } from './app.ts'
import { webConnection } from './web-connection.ts'

const state = { localToken: '' }

function localToken(): string {
	if (state.localToken) return state.localToken
	try {
		const keys = ason.parse(readFileSync(`${clientBackend.paths.stateDir}/server-keys.ason`, 'utf8')) as { tokens?: { token?: string }[] }
		state.localToken = keys.tokens?.[0]?.token ?? ''
	} catch {
		// The web server may not have created its token yet. Try again next render.
	}
	return state.localToken
}

function url(sessionId: string, blockId?: string): string {
	if (!webProtocol.isSessionPath(`/${sessionId}`)) return ''
	const remote = webConnection.state.remote
	if (!client.state.webOrigin) return '' // The server has not advertised a web endpoint.
	const origin = client.state.webOrigin
	// The authenticated server chooses its canonical browser host, not the connection alias.
	const token = remote ? remote.authToken : webLinks.localToken()
	if (!token) return ''
	let parsed: URL
	try { parsed = new URL(origin) } catch { return '' }
	if (parsed.origin !== origin || parsed.username || parsed.password) return ''
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) return ''
	if (remote && parsed.protocol !== 'https:') return ''
	const hash = blockId ? `#${encodeURIComponent(blockId)}` : ''
	return `${origin}/${sessionId}?auth=${encodeURIComponent(token)}${hash}`
}
function imageUrl(sessionId: string, blobId: string): string {
	const path = webProtocol.imagePath(sessionId, blobId)
	const sessionUrl = path && webLinks.url(sessionId)
	if (!sessionUrl) return ''
	const link = new URL(sessionUrl)
	link.pathname = path
	return link.href
}
function pasteUrl(sessionId: string, entryId: string): string {
	if (!historyIds.isValid(entryId)) return ''
	const base = webLinks.url(sessionId)
	return base ? `${base}#paste=${encodeURIComponent(entryId)}` : ''
}

export const webLinks = { state, localToken, url, imageUrl, pasteUrl }
