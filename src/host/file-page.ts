// The page behind a pasted image's or long text's marker (task 31):
// /image/<name> and /paste/<name> show the content (the image, or the
// text in a monospace block) under a header naming where the file
// really lives on the host (the /tmp path while it is there, and each
// session blob a prompt copied it into), so one knows which file to open
// in one's own tools. The raw bytes are at /raw/<name>. host/web.ts
// routes here after the login check.

import { attachments } from '../common/attachments.ts'
import { blobs } from './blobs.ts'

const pagePath = /^\/(image|paste)\/([0-9a-z]{6}\.[a-z]{3,4})$/
const rawPath = /^\/raw\/([0-9a-z]{6}\.[a-z]{3,4})$/

function escape(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const notFound = (): Response => new Response('not found\n', { status: 404 })

// Whether `pathname` is one of this module's addresses.
function owns(pathname: string): boolean {
	return pagePath.test(pathname) || rawPath.test(pathname)
}

// The page or the raw bytes at `pathname`; 404 for a name that is not
// attachments.fileName, whose kind does not fit the address, or that
// exists nowhere. `css` is the host's colour stylesheet.
function serve(pathname: string, css: string): Response {
	let raw = rawPath.exec(pathname)?.[1]
	let m = pagePath.exec(pathname)
	let name = raw ?? m?.[2]
	let found = name === undefined ? undefined : blobs.file(name)
	if (!found || (m && (m[1] === 'paste') !== (found.mediaType === 'text/plain'))) return notFound()
	if (raw) {
		let type = found.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : found.mediaType
		return new Response(new Uint8Array(found.bytes), { headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } })
	}
	let where = [...(found.tmp ? [['file', found.tmp]] : []), ...found.blobs.map((p) => ['session copy', p])]
	let header = where.map(([label, path]) => `<div><span class="label">${label}</span> <code>${escape(path!)}</code></div>`).join('')
	let body =
		found.mediaType === 'text/plain'
			? `<pre>${escape(found.bytes.toString('utf8'))}</pre>`
			: `<img src="/raw/${name}" alt="${escape(attachments.named(name!))}">`
	let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(name!)}</title><style>${css}
body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
header { padding: 12px 16px; overflow-wrap: anywhere; }
header .label { opacity: 0.7; }
main { padding: 12px 16px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
img { max-width: 100%; }
</style></head><body class="page"><header class="info">${header}<div><a href="/raw/${name}">raw</a></div></header><main>${body}</main></body></html>`
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// Where the file lives changes when a prompt copies it.
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
		},
	})
}

export const filePage = { owns, serve }
