// Authenticated read-only pages; request paths never name host files.
import { changes } from './changes.ts'
import { pages } from './pages.ts'
import { sessions } from './sessions.ts'

function escape(s: string): string { return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) }
function owns(path: string): boolean { return /^\/changes\/\d+-[a-z]{3}$/.test(path) }

async function serve(url: URL, css: string): Promise<Response> {
	let id = url.pathname.slice('/changes/'.length)
	let all = sessions.list()
	if (!all.some((s) => s.id === id)) return new Response('not found\n', { status: 404 })
	// Catch every session's marks up in slices first: after an upgrade that
	// rebuilds marks, a synchronous catch-up of the whole home would stall.
	for (let s of all) if (!s.error) await pages.slices(pages.catchUp(s.id))
	let files = changes.list(id)
	let selected = url.searchParams.get('path')
	if (selected !== null && !files.some((f) => f.path === selected)) return new Response('not found\n', { status: 404 })
	let neighbors = all.filter((s) => s.id !== id).map((s) => {
		if (s.error) throw new Error(s.error)
		return { id: s.id, name: s.meta?.name, paths: new Set(changes.list(s.id).map((f) => f.path)) }
	})
	let sections: string[] = []
	for (let file of files.filter((f) => selected === null || f.path === selected)) {
		let diff = await changes.diff(id, file.before, file.after)
		let commit = await changes.committed(id, file)
		let others = neighbors.filter((s) => s.paths.has(file.path)).map((s) => `<a href="${changes.href(s.id, file.path)}">${escape(s.id + (s.name ? `: ${s.name}` : ''))}</a>`)
		let steps: string[] = []
		for (let step of file.steps) {
			let c = step.change
			let text = c.undeclared ? `Undeclared observation: ${c.statusBefore ?? 'clean'} → ${c.statusAfter ?? 'clean'}; no content captured.` : await changes.diff(id, c.before, c.after)
			steps.push(`<details><summary>Call ${escape(step.toolId)} · ${escape(step.ts)}${c.undeclared ? ' · undeclared' : ''}</summary><pre>${escape(text)}</pre></details>`)
		}
		sections.push(`<section><h2><a href="${changes.href(id, file.path)}">${escape(file.path)}</a></h2><p>${changes.counts(diff)}${file.undeclared ? ' · includes undeclared observations' : ''}${commit ? ` · committed in ${commit}` : ''}</p>${others.length ? `<p>Also observed by ${others.join(', ')}</p>` : ''}<pre>${escape(diff)}</pre><h3>Steps per call</h3>${steps.join('')}</section>`)
	}
	let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${id} changes</title><style>${css}
body { margin: 0; background: var(--canvas); color: var(--text); font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
main { padding: 16px max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
a { color: inherit; text-decoration: underline; overflow-wrap: anywhere; }
nav { display: flex; flex-wrap: wrap; gap: 16px; }
nav a, summary { min-height: 44px; display: inline-flex; align-items: center; }
summary { cursor: pointer; overflow-wrap: anywhere; }
section { margin-top: 24px; border-top: 3px solid currentColor; }
h1, h2 { font-size: 20px; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
</style></head><body class="page"><main><nav><a href="/${id}">Session ${id}</a><a href="${changes.href(id)}">All changes (${files.length} files)</a></nav><h1>${id} · observed file changes</h1><p>Observed during calls, not proof of authorship. Commits do not clear this list. Undeclared, sensitive, large and binary files may have no textual diff.</p>${sections.join('') || '<p>No file changes since the last /changes clear.</p>'}</main></body></html>`
	return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } })
}

export const changesPage = { owns, serve }
