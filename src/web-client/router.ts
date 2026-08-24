// Minimal router for the one URL shape this app has: `/<sessionId>` selects a
// session. Solid Router and TanStack Router exist to solve nested layouts,
// route-aware data loading and typed path generation; we have one flat route
// and a WebSocket that already delivers our data. See docs/web.md.
//
// The address bar is reached through `href`/`write` so tests can drive the
// router without a DOM, and so eval can hot-patch navigation at runtime.
// A `#hash` needs no support here: the browser scrolls to a matching element
// id on its own, and switching tabs should drop it anyway.
import { createSignal } from 'solid-js'
import { webProtocol } from '../common/web.ts'

const [sessionId, setSessionId] = createSignal('')

function href(): string {
	return location.href
}

function write(url: string, replace: boolean): void {
	if (replace) history.replaceState(null, '', url)
	else history.pushState(null, '', url)
}

// The server serves the app for exactly these paths, so both sides agree on
// what a session URL looks like. Anything else means "no session in the URL"
// and the app falls back to its default tab.
function parse(from: string): string {
	const { pathname } = new URL(from)
	return webProtocol.isSessionPath(pathname) ? pathname.slice(1) : ''
}

function format(target: string): string {
	return target ? `/${target}` : '/'
}

function navigate(target: string, options?: { replace?: boolean }): void {
	// Selecting the tab you are already on must not stack history entries,
	// otherwise Back appears broken.
	if (target === router.sessionId()) return
	router.write(router.format(target), options?.replace ?? false)
	setSessionId(target)
}

function handlePopState(): void {
	setSessionId(router.parse(router.href()))
}

// Reads a one-shot query parameter (the `?auth=` token) and strips it from the
// address bar so the shareable URL stays `/<sessionId>`.
function takeSearchParam(name: string): string {
	const url = new URL(router.href())
	const value = url.searchParams.get(name)
	if (!value) return ''
	url.searchParams.delete(name)
	router.write(`${url.pathname}${url.search}${url.hash}`, true)
	return value
}

// Adopts the URL the page was opened with, then keeps the route in sync with
// Back/Forward. Returns a cleanup so callers can unsubscribe.
function start(): () => void {
	router.handlePopState()
	const onPopState = () => router.handlePopState()
	addEventListener('popstate', onPopState)
	return () => removeEventListener('popstate', onPopState)
}

export const router = { sessionId, href, write, parse, format, navigate, handlePopState, takeSearchParam, start }
