// Converts Hal history messages into ACP prompt content blocks (text and
// images) and tracks whether a Hal history extends what `agy` has seen.
// Task xbp.

import { realpathSync } from 'fs'
import { resolve } from 'path'
import { blocks, type ImageBlock, type Message } from '../common/blocks.ts'
import { strings } from '../common/strings.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { provider, type ProviderRequest } from './provider.ts'

export type AcpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export type PrefixState = {
	acpSession?: string
	cwd?: string
	prefix: number
	hash?: string
	basePrefix?: number
	baseHash?: string
	account?: string
}

export type PrefixSnapshot = Pick<PrefixState, 'prefix' | 'hash' | 'basePrefix' | 'baseHash'>

export type UnseenResult = {
	messages: Message[]
	edited?: true
	basePrefix: number
	baseHash: string
}

type Saved = {
	acpSession?: string
	cwd?: string
	prefix?: number
	hash?: string
	basePrefix?: number
	baseHash?: string
	account?: string
}

function loadSaved(sessionId: string): Saved {
	let data = liveFiles.liveFile<Saved>(`${paths.sessionDir(sessionId)}/agy.ason`, {}, { watch: false })
	let copy = {
		acpSession: data.acpSession,
		cwd: data.cwd,
		prefix: data.prefix,
		hash: data.hash,
		basePrefix: data.basePrefix,
		baseHash: data.baseHash,
		account: data.account,
	}
	liveFiles.close(data)
	return copy
}

function saveState(sessionId: string, state: PrefixState): void {
	let data = liveFiles.liveFile<Saved>(`${paths.sessionDir(sessionId)}/agy.ason`, {}, { watch: false })
	Object.assign(data, {
		acpSession: state.acpSession,
		cwd: state.cwd,
		prefix: state.prefix,
		hash: state.hash,
		basePrefix: state.basePrefix,
		baseHash: state.baseHash,
		account: state.account,
	})
	liveFiles.save(data)
	liveFiles.close(data)
}

function hostedSeedText(text: string): string {
	let body = text
	if (body.startsWith('<hal-note>')) body = body.slice('<hal-note>'.length)
	if (body.endsWith('</hal-note>')) body = body.slice(0, -'</hal-note>'.length)
	body = body.trim()
	if (body.length > agyPrompt.maxHostedSeedChars)
		body = `${strings.sliceText(body, 0, agyPrompt.maxHostedSeedChars)}... [truncated; use READ_ENTRY for full output]`
	return `[hosted tool] ${body}`
}

function isHostedMessage(m: Message): boolean {
	return m.role === 'user' && m.blocks.some((b) => b.type === 'text' && b.hosted)
}

function splitIndex(messages: Message[]): number {
	return messages.findLastIndex((m) => m.role === 'assistant' || isHostedMessage(m))
}

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
				if (b.hosted) {
					if (note) addText(hostedSeedText(b.text))
					continue
				}
				if (!b.text) continue
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

// What agy has not seen yet: messages after its prefix, or an edit of its
// last prompt (matching basePrefix/baseHash so the live ACP session stays
// intact instead of re-seeding). Undefined: agy must start over.
function unseen(state: PrefixState, messages: Message[], cwd: string): UnseenResult | undefined {
	if (!state.acpSession || state.cwd !== cwd) return undefined
	if (messages.length >= state.prefix && agyPrompt.hash(messages.slice(0, state.prefix)) === state.hash) {
		let rest = messages.slice(state.prefix)
		let i = rest[0]?.role === 'assistant' ? 1 : 0
		let tail = rest.slice(i)
		if (tail.every((m) => m.role === 'user')) {
			let basePrefix = state.prefix + i
			return { messages: tail, basePrefix, baseHash: agyPrompt.hash(messages.slice(0, basePrefix)) }
		}
	}
	if (
		state.basePrefix !== undefined &&
		state.basePrefix > 0 &&
		messages.length >= state.basePrefix &&
		agyPrompt.hash(messages.slice(0, state.basePrefix)) === state.baseHash
	) {
		let tail = messages.slice(state.basePrefix)
		if (tail.every((m) => m.role === 'user'))
			return { messages: tail, edited: true, basePrefix: state.basePrefix, baseHash: state.baseHash! }
	}
	return undefined
}

function promptContent(messages: Message[], req: ProviderRequest, edited?: boolean): AcpContent[] {
	let content = agyPrompt.toContent(messages, req, false)
	if (!content.length) content = [{ type: 'text', text: 'Continue where you left off.' }]
	if (edited)
		content.unshift({
			type: 'text',
			text: '<hal-note>The user edited their previous prompt. Disregard the previous version and respond to this edited version instead.</hal-note>',
		})
	return content
}

function recordPrefix(sessionId: string, state: PrefixState, messages: Message[], base?: UnseenResult): void {
	state.prefix = messages.length
	state.hash = agyPrompt.hash(messages)
	if (base) {
		state.basePrefix = base.basePrefix
		state.baseHash = base.baseHash
	} else {
		let split = agyPrompt.splitIndex(messages)
		state.basePrefix = split + 1
		state.baseHash = split >= 0 ? agyPrompt.hash(messages.slice(0, split + 1)) : undefined
	}
	agyPrompt.saveState(sessionId, state)
}

function snapshot(state: PrefixState): PrefixSnapshot {
	return { prefix: state.prefix, hash: state.hash, basePrefix: state.basePrefix, baseHash: state.baseHash }
}

function resetPrefix(state: PrefixState): void {
	state.prefix = 0
	state.hash = undefined
	state.basePrefix = undefined
	state.baseHash = undefined
}

function restore(sessionId: string, state: PrefixState, snap: PrefixSnapshot): void {
	Object.assign(state, snap)
	agyPrompt.saveState(sessionId, state)
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

function textLen(parts: AcpContent[]): number {
	return parts.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0)
}

function mergeContent(groups: AcpContent[][]): AcpContent[] {
	let out: AcpContent[] = []
	for (let parts of groups)
		for (let p of parts) {
			let last = out.at(-1)
			if (p.type === 'text' && last?.type === 'text') last.text += `\n\n${p.text}`
			else out.push(p.type === 'text' ? { ...p } : p)
		}
	return out
}

// Keeps seeded transcripts well below agy's ~192 KB USER_REQUEST truncation
// wall, prioritizing the current prompt (`now`) and the newest prior turns.
function seed(req: ProviderRequest): AcpContent[] {
	let split = agyPrompt.splitIndex(req.messages)
	let now = agyPrompt.toContent(req.messages.slice(split + 1), req, false)
	if (split < 0) return now
	let tail: AcpContent[] = now.length ? now : [{ type: 'text', text: 'Continue where you left off.' }]
	let budget = Math.max(0, agyPrompt.maxSeedChars - textLen(tail) - 500)
	if (budget <= 0) return tail
	let kept: AcpContent[][] = []
	let remaining = budget
	let omitted = 0
	for (let i = split; i >= 0; i--) {
		let parts = agyPrompt.toContent([req.messages[i]!], req, true)
		if (!parts.length) continue
		let len = textLen(parts)
		if (len <= remaining) {
			kept.unshift(parts)
			remaining -= len + 2
		} else if (!kept.length && remaining > 80) {
			let clipped: AcpContent[] = []
			for (let p of parts) {
				if (p.type !== 'text') clipped.push(p)
				else if (remaining > 0) {
					let slice = strings.sliceText(p.text, 0, remaining)
					clipped.push({ type: 'text', text: `${slice}... [truncated]` })
					remaining = 0
				}
			}
			kept.unshift(clipped)
			omitted = i
			break
		} else {
			omitted = i + 1
			break
		}
	}
	let before = mergeContent(kept)
	if (!before.length) return tail
	let head =
		"<hal-transcript>\nThe conversation so far in this Hal session, which you continue. Earlier tool calls were Hal's, not yours." +
		(omitted
			? `\n[... ${omitted} earlier message${omitted === 1 ? '' : 's'} omitted to fit agy's prompt limit; use READ_ENTRY if needed ...]`
			: '')
	return [{ type: 'text', text: head }, ...before, { type: 'text', text: '</hal-transcript>' }, ...tail]
}

export const agyPrompt = {
	maxSeedChars: 120_000,
	maxHostedSeedChars: 600,
	hash,
	splitIndex,
	toContent,
	unseen,
	promptContent,
	recordPrefix,
	snapshot,
	resetPrefix,
	restore,
	system,
	seed,
	loadSaved,
	saveState,
}
