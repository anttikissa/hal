// The page behind a pasted image's or long text's marker (task 31):
// /image/<name> and /paste/<name> show the content (the image, or the
// text in a monospace block) under a header naming where the file
// really lives on the host (the /tmp path while it is there, and each
// session blob a prompt copied it into), so one knows which file to open
// in one's own tools. The raw bytes are at /raw/<name>. host/web.ts
// routes here after the login check.
//
// Files the model shares (SYSTEM.md) live under paths.fileDir() at any
// path of plain names: /file/<path> shows an HTML file as itself and
// anything else on the same page as a paste; a request that is not a
// page load (an HTML page's own images, styles and scripts) and
// /raw/<path> get the bytes.

import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { attachments } from '../common/attachments.ts'
import { blobs } from './blobs.ts'
import { paths } from './paths.ts'

// The close button: back to the app page that linked here (a home-screen
// web app has no back button), else to the app itself.
const closeScript = `document.querySelector('.close').onclick = (e) => { if (history.length > 1) { e.preventDefault(); history.back() } }`
const closeHash = createHash('sha256').update(closeScript).digest('base64')

const pagePath = /^\/(image|paste|file)\/([0-9a-z]{6})(?:\.([a-z0-9]{1,8}))?$/
const rawPath = /^\/raw\/([0-9a-z]{6}\.[a-z0-9]{1,8})$/
// No part may start with a dot, so no .. and no hidden files.
const sharedPath = /^\/(file|raw)\/((?:[\w-][\w.-]*\/)*[\w-][\w.-]*)$/

function escape(s: string): string {
	return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const notFound = (): Response => new Response('not found\n', { status: 404 })

// The separate header reader runs only for an image page, never during
// host startup. A malformed image simply has no resolution line.
function dimensions(bytes: Buffer, type: string): string | undefined {
	let out = Bun.spawnSync([process.execPath, `${import.meta.dir}/../../scripts/image-dimensions.ts`, type], {
		stdin: bytes,
	})
	return out.exitCode === 0 ? out.stdout.toString().trim() || undefined : undefined
}

function size(bytes: number): string {
	return bytes < 1000
		? `${bytes} B`
		: bytes < 1e6
			? `${Math.floor(bytes / 100) / 10} kB`
			: `${Math.floor(bytes / 1e5) / 10} MB`
}

// Whether `pathname` is one of this module's addresses.
function owns(pathname: string): boolean {
	return pagePath.test(pathname) || rawPath.test(pathname) || sharedPath.test(pathname)
}

// The page or the raw bytes at `pathname`; 404 for a name that is not
// attachments.fileName, whose kind does not fit the address, or that
// exists nowhere, unless it is a shared file. `css` is the host's color
// stylesheet; `dest` the request's Sec-Fetch-Dest.
function serve(pathname: string, css: string, dest?: string | null): Response {
	let raw = rawPath.exec(pathname)?.[1]
	let m = pagePath.exec(pathname)
	let stem = m?.[2]
	// An extensionless page has exactly one matching file; never guess if
	// different formats happen to share the same six-character stem.
	let exts =
		m?.[1] === 'paste'
			? [...attachments.textExts]
			: m?.[1] === 'file'
				? []
				: Object.entries(attachments.types)
						.filter(([type]) => type !== 'text/plain')
						.map(([, ext]) => ext)
	let names = stem && !m?.[3] ? exts.map((ext) => `${stem}.${ext}`).filter((n) => !!blobs.file(n)) : []
	let name = raw ?? (m?.[3] ? `${stem}.${m[3]}` : names.length === 1 ? names[0] : undefined)
	let found = name === undefined ? undefined : blobs.file(name)
	if (
		!found ||
		(m &&
			(m[1] === 'paste'
				? found.mediaType !== 'text/plain'
				: m[1] === 'file'
					? found.mediaType !== 'application/octet-stream'
					: !found.mediaType.startsWith('image/')))
	)
		return shared(pathname, css, dest)
	if (raw) {
		let type = found.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : found.mediaType
		return new Response(new Uint8Array(found.bytes), {
			headers: {
				'content-type': type,
				'content-disposition':
					found.mediaType === 'application/octet-stream' ? `attachment; filename="${name}"` : 'inline',
				'x-content-type-options': 'nosniff',
				'cache-control': 'private, max-age=31536000, immutable',
			},
		})
	}
	let where = [...(found.tmp ? [['file', found.tmp]] : []), ...found.blobs.map((p) => ['session copy', p])]
	return page(name!, `/raw/${name}`, found.mediaType, found.bytes, where, css)
}

// A shared file under paths.fileDir(), served as described at the top.
function shared(pathname: string, css: string, dest?: string | null): Response {
	let m = sharedPath.exec(pathname)
	let path = m && `${paths.fileDir()}/${m[2]}`
	if (!path || !statSync(path, { throwIfNoEntry: false })?.isFile()) return notFound()
	let file = Bun.file(path)
	let name = m![2]!.split('/').pop()!
	let mediaType = attachments.fileKind(name, file.type) ?? 'application/octet-stream'
	if (m![1] === 'raw' || (dest && dest !== 'document') || file.type.startsWith('text/html'))
		return new Response(file, {
			headers: { 'content-type': file.type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
		})
	return page(name, `/raw/${m![2]}`, mediaType, readFileSync(path), [['file', path]], css)
}

// The page of one file: where it lives, links to `rawUrl`, its content.
function page(name: string, rawUrl: string, mediaType: string, bytes: Buffer, where: string[][], css: string): Response {
	// "file /tmp/hal/image/ain96g.png (384 x 298, 50.4 kB)": no format,
	// the extension already says it.
	let detail = [mediaType.startsWith('image/') && dimensions(bytes, mediaType), size(bytes.length)]
		.filter(Boolean)
		.join(', ')
	let header = where
		.map(
			([label, path], i) =>
				`<div><span class="label">${label}</span> <code>${escape(path!)}</code>${i ? '' : ` (${escape(detail)})`}</div>`,
		)
		.join('')
	let body =
		mediaType === 'text/plain'
			? `<pre>${escape(bytes.toString('utf8'))}</pre>`
			: mediaType === 'application/octet-stream'
				? `<p>Binary file. Use the host path above or download the original.</p>`
				: `<img src="${escape(rawUrl)}" alt="${escape(attachments.nameType(name) ? attachments.named(name) : name)}">`
	let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escape(name)}</title><style>${css}
html { color-scheme: dark; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
header { padding: 12px 72px 12px 16px; overflow-wrap: anywhere; }
header .label { color: var(--quiet); }
header a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
header .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
header .actions a { display: inline-flex; align-items: center; min-height: 44px; }
header .actions a[download] { background: var(--button); padding: 0 14px; border-radius: 6px; }
.close { position: fixed; top: max(8px, env(safe-area-inset-top)); right: max(8px, env(safe-area-inset-right)); width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; background: var(--button); color: var(--text); border-radius: 24px; }
.close svg { width: 20px; height: 20px; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; }
main { padding: 12px 16px; }
pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
img { max-width: 100%; }
</style></head><body class="page"><a class="close" href="/" aria-label="Close" title="Close"><svg viewBox="0 0 20 20"><path d="M3 3 17 17M17 3 3 17"/></svg></a><header>${header}<div class="actions"><a href="${escape(rawUrl)}">Open original</a><a href="${escape(rawUrl)}" download="${escape(name)}">Download</a></div></header><main>${body}</main><script>${closeScript}</script></body></html>`
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			// Where the file lives changes when a prompt copies it.
			'cache-control': 'no-store',
			'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${closeHash}'`,
		},
	})
}

export const filePage = { owns, serve }
