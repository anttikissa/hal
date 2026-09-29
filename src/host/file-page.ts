// The page behind a pasted image's or long text's marker (task 31):
// /image/<name> and /paste/<name> show the content (the image, or the
// text in a monospace block) under a header naming where the file
// really lives on the host (the /tmp path while it is there, and each
// session blob a prompt copied it into), so one knows which file to open
// in one's own tools. The raw bytes are at /raw/<name>. host/web.ts
// routes here after the login check.

import { attachments } from '../common/attachments.ts'
import { blobs } from './blobs.ts'

const pagePath = /^\/(image|paste|file)\/([0-9a-z]{6})(?:\.([a-z0-9]{1,8}))?$/
const rawPath = /^\/raw\/([0-9a-z]{6}\.[a-z0-9]{1,8})$/

function escape(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const notFound = (): Response => new Response('not found\n', { status: 404 })

// The separate header reader runs only for an image page, never during
// host startup. A malformed image simply has no resolution line.
function dimensions(bytes: Buffer, type: string): string | undefined {
	let out = Bun.spawnSync([process.execPath, `${import.meta.dir}/../../scripts/image-dimensions.ts`, type], { stdin: bytes })
	return out.exitCode === 0 ? out.stdout.toString().trim() || undefined : undefined
}

function size(bytes: number): string {
	return bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${Math.floor(bytes / 100) / 10} kB` : `${Math.floor(bytes / 1e5) / 10} MB`
}

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
	let stem = m?.[2]
	// An extensionless page has exactly one matching file; never guess if
	// different formats happen to share the same six-character stem.
	let exts = m?.[1] === 'paste' ? [...attachments.textExts] : m?.[1] === 'file' ? [] : Object.entries(attachments.types).filter(([type]) => type !== 'text/plain').map(([, ext]) => ext)
	let names = stem && !m?.[3] ? exts.map((ext) => `${stem}.${ext}`).filter((n) => !!blobs.file(n)) : []
	let name = raw ?? (m?.[3] ? `${stem}.${m[3]}` : names.length === 1 ? names[0] : undefined)
	let found = name === undefined ? undefined : blobs.file(name)
	if (!found || (m && (m[1] === 'paste' ? found.mediaType !== 'text/plain' : m[1] === 'file' ? found.mediaType !== 'application/octet-stream' : !found.mediaType.startsWith('image/')))) return notFound()
	if (raw) {
		let type = found.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : found.mediaType
		return new Response(new Uint8Array(found.bytes), { headers: { 'content-type': type, 'content-disposition': found.mediaType === 'application/octet-stream' ? `attachment; filename="${name}"` : 'inline', 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } })
	}
	// "file /tmp/hal/image/ain96g.png (384 x 298, 50.4 kB)": no format,
	// the extension already says it.
	let detail = [found.mediaType.startsWith('image/') && dimensions(found.bytes, found.mediaType), size(found.bytes.length)].filter(Boolean).join(', ')
	let where = [...(found.tmp ? [['file', found.tmp]] : []), ...found.blobs.map((p) => ['session copy', p])]
	let header = where.map(([label, path], i) => `<div><span class="label">${label}</span> <code>${escape(path!)}</code>${i ? '' : ` (${escape(detail)})`}</div>`).join('')
	let body =
		found.mediaType === 'text/plain'
			? `<pre>${escape(found.bytes.toString('utf8'))}</pre>`
			: found.mediaType === 'application/octet-stream' ? `<p>Binary file. Use the host path above or download the original.</p>`
			: `<img src="/raw/${name}" alt="${escape(attachments.named(name!))}">`
	let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(name!)}</title><style>${css}
body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
header { padding: 12px 16px; overflow-wrap: anywhere; }
header .label { color: var(--quiet); }
header a { color: var(--code); text-decoration: underline; text-underline-offset: 2px; }
header .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
header .actions a { display: inline-flex; align-items: center; min-height: 44px; }
header .actions a[download] { background: var(--button); color: var(--text); padding: 0 14px; border-radius: 6px; }
main { padding: 12px 16px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
img { max-width: 100%; }
</style></head><body class="page"><header class="info">${header}<div class="actions"><a href="/raw/${name}">Open original</a><a href="/raw/${name}" download="${name}">Download</a></div></header><main>${body}</main></body></html>`
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
