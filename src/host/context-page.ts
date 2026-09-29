// The context graph page (task c4): /context/<session>, an SVG built
// here from history, one stacked bar per provider round, and
// /context/<session>/events, a stream pushing the redrawn graph as rounds
// finish (the browser never polls). Authenticated and read-only, like
// the changes pages; its one script only swaps in pushed markup and
// shows a tapped bar's facts.
import { context, type Cause, type Point } from './context.ts'
import { sessions } from './sessions.ts'

const W = 400, H = 340, AXIS = 44, L = 6, R = 12, T = 22, B = 34, SLOT = 14
const LETTER: Record<Cause, string> = { compaction: 'C', clear: 'X', 'pruning checkpoint': 'P', 'cache miss': 'M' }
const TONE: Record<Cause, string> = { compaction: 'tool-edit', clear: 'tool-edit', 'pruning checkpoint': 'fork', 'cache miss': 'assistant' }

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const kilo = (n: number): string => (n < 1000 ? String(n) : `${Math.round(n / 100) / 10}k`)
const owns = (path: string): boolean => /^\/context\/\d+-[a-z]{3}(\/events)?$/.test(path)

function tip(p: Point): string {
	let date = new Date(p.ts).toUTCString()
	let split = p.approx ? 'turn end only, rounds not recorded' : `uncached ${p.input}, cache read ${p.cacheRead}, cache write ${p.cacheWrite}`
	return `Round ${p.round} · turn ${p.turn} · ${p.total} tokens (${split}) · ${date}${p.cause ? ` · after ${p.cause}` : ''}`
}

// A tick step of 1, 2 or 5 times a power of ten, about four to a chart.
function step(max: number): number {
	let raw = Math.max(1, max / 4), pow = 10 ** Math.floor(Math.log10(raw))
	return ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow
}

function svg(id: string, pts: Point[]): string {
	let width = Math.max(W, L + R + pts.length * SLOT)
	let top = Math.max(...pts.map((p) => p.total)), win = Math.max(...pts.map((p) => p.window ?? 0))
	let tick = step(Math.max(top, Math.min(win || top, top * 2.5)) * 1.05)
	let max = Math.ceil(Math.max(top, Math.min(win || top, top * 2.5)) * 1.05 / tick) * tick
	let y = (v: number) => T + (H - T - B) * (1 - Math.min(v, max) / max)
	let axis: string[] = [`<svg class="axis" xmlns="http://www.w3.org/2000/svg" width="${AXIS}" height="${H}" aria-hidden="true">`]
	let out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" role="img" aria-label="Context size per provider round">`]
	for (let v = 0; v <= max; v += tick) {
		out.push(`<line class="grid" x1="0" x2="${width}" y1="${y(v)}" y2="${y(v)}"/>`)
		axis.push(`<text class="lbl" x="${AXIS - 4}" y="${y(v) + 4}" text-anchor="end">${kilo(v)}</text>`)
	}
	let path = pts.map((p, i) => p.window ? `${L + i * SLOT},${y(p.window)} ${L + (i + 1) * SLOT},${y(p.window)}` : '').filter(Boolean).join(' ')
	if (path) out.push(`<polyline class="win" points="${path}"/>`)
	let labelled = -99
	pts.forEach((p, i) => {
		let x = L + i * SLOT
		if (i === 0 || p.turn !== pts[i - 1]!.turn) {
			out.push(`<line class="turn" x1="${x}" x2="${x}" y1="${T}" y2="${H - B}"/>`)
			if (x - labelled >= 36) out.push(`<text class="lbl" x="${x + 3}" y="${H - B + 14}">t${p.turn}</text>`)
			if (x - labelled >= 36) labelled = x
		}
		if (p.cause) out.push(`<line class="cause ${TONE[p.cause]}" x1="${x + 7}" x2="${x + 7}" y1="${T}" y2="${H - B}"/><text class="mark ${TONE[p.cause]}" x="${x + 7}" y="${T - 6}" text-anchor="middle">${LETTER[p.cause]}</text>`)
		let stack = 0, bar = (v: number, tone: string) => {
			if (!v) return ''
			let h = y(stack) - y(stack + v)
			stack += v
			return `<rect class="k ${tone}" x="${x + 2}" y="${y(stack)}" width="10" height="${Math.max(h, 1)}"/>`
		}
		let href = `/${id}${p.block === undefined ? '' : `#${p.block}`}`
		out.push(`<a class="pt" href="${href}"><title>${escape(tip(p))}</title>${bar(p.cacheRead, 'status-cool')}${bar(p.cacheWrite, 'status-warm')}${bar(p.input, 'status-hot')}<rect class="hit" x="${x}" y="${T}" width="${SLOT}" height="${H - T - B}"/></a>`)
	})
	out.push('</svg>')
	axis.push('</svg>')
	return `${axis.join('')}<div class="scroll">${out.join('')}</div>`
}

function events(id: string, pts: Point[]): string {
	let list = pts.flatMap((p, i) => p.cause ? [`<li><a href="/${id}${p.block === undefined ? '' : `#${p.block}`}">Round ${p.round}</a> · ${p.cause}: ${kilo(pts[i - 1]!.total)} → ${kilo(p.total)}</li>`] : []).reverse().slice(0, 50)
	return list.length ? `<ul>${list.join('')}</ul>` : ''
}

// The graph's markup: what the page holds and each push replaces.
function graph(id: string): string {
	let pts = context.of(id)
	if (!pts.length) return '<p>No provider rounds recorded yet.</p>'
	let win = pts.at(-1)!.window
	return `<div class="plot">${svg(id, pts)}</div><p class="key"><span class="status-cool">■</span> cache read <span class="status-warm">■</span> cache write <span class="status-hot">■</span> uncached input · ${win ? `dashed line: context window ${kilo(win)} · ` : ''}C compaction, X clear, P pruning checkpoint, M cache miss · t = turn</p>${events(id, pts)}`
}

const style = `body { margin: 0; background: var(--canvas); color: var(--text); font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { padding: 16px max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); max-width: 1000px; }
a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }
nav { display: flex; flex-wrap: wrap; gap: 16px; }
nav a, li a { min-height: 44px; display: inline-flex; align-items: center; }
h1 { font-size: 20px; overflow-wrap: anywhere; }
.plot { display: flex; border: 3px solid var(--border); background: var(--field); }
.axis { flex: none; }
.scroll { flex: 1; min-width: 0; overflow-x: auto; }
svg { display: block; font: 12px ui-monospace, Menlo, monospace; }
svg .k, svg .lbl, svg .mark { fill: currentColor; stroke: none; }
svg .lbl { color: var(--text); }
svg .grid, svg .turn { stroke: var(--quiet); stroke-width: 1; }
svg .turn { stroke-dasharray: 2 3; }
svg .win { fill: none; stroke: var(--accent); stroke-width: 2; stroke-dasharray: 6 3; }
svg .cause { stroke: currentColor; stroke-width: 2; stroke-dasharray: 4 3; }
svg .mark { font-weight: bold; font-size: 14px; }
svg .hit { fill: transparent; }
svg a.pt:hover .k, svg a.pt:focus .k { stroke: var(--text); stroke-width: 1.5; }
#info { min-height: 3em; overflow-wrap: anywhere; }
ul { padding-left: 20px; }`
const script = `let g = document.getElementById('graph'), info = document.getElementById('info'), plot = () => g.querySelector('.scroll')
let end = () => { let p = plot(); if (p) p.scrollLeft = p.scrollWidth }
end()
new EventSource(location.pathname + '/events').onmessage = (e) => {
	let p = plot(), atEnd = !p || p.scrollLeft + p.clientWidth >= p.scrollWidth - 4, x = p ? p.scrollLeft : 0
	g.innerHTML = JSON.parse(e.data)
	let q = plot()
	if (q) q.scrollLeft = atEnd ? q.scrollWidth : x
}
g.addEventListener('click', (e) => {
	let a = e.target.closest('a.pt')
	if (!a) return
	e.preventDefault()
	let link = document.createElement('a')
	link.href = a.getAttribute('href')
	link.textContent = 'Open this block'
	info.replaceChildren(a.querySelector('title').textContent + ' ', link)
})`

function page(id: string, css: string): Response {
	let nonce = crypto.randomUUID()
	let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${id} context</title><style>${css}\n${style}</style></head><body class="page"><main><nav><a href="/${id}">Session ${id}</a><a href="/changes/${id}">Changes</a></nav><h1>${id} · context size per provider round</h1><div id="graph">${graph(id)}</div><p id="info" aria-live="polite">Tap a bar for its round.</p><script nonce="${nonce}">${script}</script></main></body></html>`
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'` } })
}

// One event stream per open page; each push is the whole graph.
function stream(id: string, signal: AbortSignal): Response {
	let send: (() => void) | undefined
	let body = new ReadableStream({
		start(controller) {
			let enc = new TextEncoder()
			send = () => controller.enqueue(enc.encode(`data: ${JSON.stringify(graph(id))}\n\n`))
			let subs = contextPage.state.subs.get(id) ?? new Set()
			contextPage.state.subs.set(id, subs)
			subs.add(send)
			signal.addEventListener('abort', () => { subs.delete(send!); if (!subs.size) contextPage.state.subs.delete(id) })
			send()
		},
	})
	return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

function serve(req: Request, css: string, timeout: (req: Request) => void): Response {
	let path = new URL(req.url).pathname.split('/')
	let id = path[2]!
	if (!sessions.list().some((s) => s.id === id)) return new Response('not found\n', { status: 404 })
	if (path[3] !== 'events') return page(id, css)
	timeout(req)
	return stream(id, req.signal)
}

// A finished round or turn (stats.round, stats.ended) redraws the pages.
function notify(id: string): void {
	for (let send of contextPage.state.subs.get(id) ?? []) send()
}

export const contextPage = { state: { subs: new Map<string, Set<() => void>>() }, owns, serve, notify, graph }
