// Converts Hal history messages into ACP prompt content blocks (text and
// images) and tracks whether a Hal history extends what `agy` has seen.
// Task xbp.

import { realpathSync } from 'fs'
import { resolve } from 'path'
import { blocks, type ImageBlock, type Message } from '../common/blocks.ts'
import { strings } from '../common/strings.ts'
import { provider, type ProviderRequest } from './provider.ts'

export type AcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type PrefixState = {
	acpSession?: string
	cwd?: string
	prefix: number
	hash?: string
}

// Hal's notes about hosted tools repeat what agy did; agy knows.
const hostedNote = /^<hal-note>Your \S+ (?:ran|failed) on the provider:/

function hash(messages: Message[]): string {
	return String(Bun.hash(JSON.stringify(messages.map((m) => ({ role: m.role, blocks: m.blocks })))))
}

function imagePart(img: ImageBlock, req: ProviderRequest): AcpContent {
	let data = req.image?.(img.blob)
	return data
		? { type: 'image', data: data.data, mimeType: data.mediaType }
		: { type: 'text', text: provider.imageNote('the image file is no longer available') }
}

function toContent(messages: Message[], req: ProviderRequest, note: boolean): AcpContent[] {
	let out: AcpContent[] = []
	let pushText = (text: string) => {
		let last = out.at(-1)
		if (last?.type === 'text') last.text += `\n\n${text}`
		else out.push({ type: 'text', text })
	}
	for (let m of messages) {
		let parts: AcpContent[] = []
		let addText = (text: string) => {
			let last = parts.at(-1)
			if (last?.type === 'text') last.text += `\n${text}`
			else parts.push({ type: 'text', text })
		}
		for (let b of m.blocks) {
			if (b.type === 'text') {
				if (!note && hostedNote.test(b.text)) continue
				addText(b.text)
			} else if (b.type === 'tool_call') addText(`[tool call] ${String(b.input.cmd ?? JSON.stringify(b.input))}`)
			else if (b.type === 'tool_result') {
				addText(`[tool result${b.isError ? ', error' : ''}] ${strings.sliceText(b.output, 0, 4000)}`)
				for (let img of blocks.resultImages(b)) parts.push(imagePart(img, req))
			} else if (b.type === 'image') parts.push(imagePart(b, req))
		}
		if (!parts.length) continue
		if (note) {
			let head = `## ${m.role === 'user' ? 'User' : 'Assistant'}`
			if (parts[0]?.type === 'text') parts[0] = { type: 'text', text: `${head}\n${parts[0].text}` }
			else parts.unshift({ type: 'text', text: head })
		}
		for (let p of parts)
			if (p.type === 'text') pushText(p.text)
			else out.push(p)
	}
	return out
}

// What agy has not seen yet: messages after its prefix, if they are only
// agy's own reply and new user input. Undefined: agy must start over.
function unseen(state: PrefixState, messages: Message[], cwd: string): Message[] | undefined {
	if (!state.acpSession || state.cwd !== cwd || messages.length < state.prefix) return undefined
	if (agyPrompt.hash(messages.slice(0, state.prefix)) !== state.hash) return undefined
	let rest = messages.slice(state.prefix)
	let i = rest[0]?.role === 'assistant' ? 1 : 0
	return rest.slice(i).every((m) => m.role === 'user') ? rest.slice(i) : undefined
}

// Hal's system prompt, appended to agy's own through session/new's
// _meta.antigravity.systemPrompt. agy reads <cwd>/AGENTS.md on its own,
// so its copy is left out.
function system(req: ProviderRequest, cwd: string): string {
	let text = req.system ?? ''
	if (!text) return ''
	let own = resolve(cwd, 'AGENTS.md')
	let names = [own]
	try {
		names.push(realpathSync(own))
	} catch {}
	for (let name of names) {
		let start = text.indexOf(`<file path="${name}">\n`)
		let end = start < 0 ? -1 : text.indexOf('\n</file>', start)
		if (end >= 0) text = text.slice(0, start) + text.slice(end + '\n</file>'.length)
	}
	return `${text}\n\nYour own tools replace Hal's BASH, READ, EDIT and GREP; Hal's other tools are your ide-tools MCP tools. Write file paths as plain inline code, not markdown file:// links.`
}

function seed(req: ProviderRequest): AcpContent[] {
	let last = req.messages.findLastIndex((m) => m.role === 'assistant')
	let before = agyPrompt.toContent(req.messages.slice(0, last + 1), req, true)
	let now = agyPrompt.toContent(req.messages.slice(last + 1), req, false)
	if (!before.length) return now
	return [
		{
			type: 'text',
			text: "<hal-transcript>\nThe conversation so far in this Hal session, which you continue. Earlier tool calls were Hal's, not yours.",
		},
		...before,
		{ type: 'text', text: '</hal-transcript>' },
		...now,
	]
}

export const agyPrompt = { hash, toContent, unseen, system, seed }
