// Fetch a URL into readable text, a model-visible image, or a local file.
import { mkdirSync } from 'fs'
import { attachments } from '../../common/attachments.ts'
import { paths } from '../paths.ts'
import { type Tool, type ToolOutput, tools } from '../tools.ts'

function entities(text: string): string {
	const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©' }
	return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (whole, key: string) => {
		if (key[0] !== '#') return named[key.toLowerCase()] ?? whole
		let point = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10)
		return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole
	})
}

function htmlText(html: string): string {
	let title = entities((html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '').replace(/<[^>]*>/g, '').trim())
	let body = html.replace(/<!--[^]*?-->/g, '').replace(/<(script|style|noscript|template|head)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
	body = body.replace(/<br\b[^>]*\/?>/gi, '\n').replace(/<\/?(?:p|div|section|article|main|header|footer|nav|h[1-6]|li|ul|ol|blockquote|pre|table|tr|td|th|hr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
	body = entities(body).replace(/\r\n?/g, '\n').replace(/[\t \f]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
	return [title, body].filter(Boolean).join('\n\n')
}

export const tool: Tool<ToolOutput> = {
	name: 'read_url',
	description: 'Read a web page or text file, extracting readable text from HTML. Images are attached; other files are saved under /tmp.',
	parameters: { type: 'object', properties: { url: { type: 'string', description: 'HTTP or HTTPS URL to read' } }, required: ['url'] },
	readOnly: true,
	async run(input, ctx) {
		if (typeof input.url !== 'string') throw new Error('url must be an http(s) URL')
		let url: URL
		try { url = new URL(input.url) } catch { throw new Error('invalid URL') }
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must use http or https')
		let signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
		let res = await fetch(url, { signal })
		if (!res.ok) throw new Error(`HTTP ${res.status} reading ${url}`)
		let type = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase()
		if (type.startsWith('image/') && attachments.types[type] && type !== 'text/plain') {
			let size = Number(res.headers.get('content-length'))
			if (size > attachments.maxBytes()) throw new Error(`image larger than ${attachments.maxBytes()} bytes`)
			let bytes = new Uint8Array(await res.arrayBuffer())
			if (bytes.length > attachments.maxBytes()) throw new Error(`image larger than ${attachments.maxBytes()} bytes`)
			return { text: `Image from ${res.url} (${type}, ${bytes.length} bytes)`, image: { mediaType: type, data: Buffer.from(bytes).toString('base64') } }
		}
		let bytes = new Uint8Array(await res.arrayBuffer())
		if (type === 'text/html' || type === 'application/xhtml+xml' || type.startsWith('text/') || type === 'application/json' || type.endsWith('+json')) {
			let text = new TextDecoder().decode(bytes)
			return tools.cap(type === 'text/html' || type === 'application/xhtml+xml' ? htmlText(text) : text)
		}
		let dir = paths.fileDir()
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		let name = `${crypto.randomUUID()}${/\.[a-z0-9]{1,12}$/i.exec(new URL(res.url).pathname)?.[0] ?? ''}`
		let path = `${dir}/${name}`
		await Bun.write(path, bytes)
		return `Saved ${res.url} to ${path} (${type}, ${bytes.length} bytes)`
	},
}
