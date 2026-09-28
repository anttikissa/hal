// Pastes that become attachments in the terminal (task zc): an image on
// the clipboard (Ctrl-V), a pasted line that is the path of an image or
// text file (a drop; the same files the web attaches, common
// attachments.fileKind), and text longer than settings.pasteLines(). Each is sent with an
// `attach` command and stands in the prompt as a placeholder until the
// host answers (common/uploads.ts). The command goes after the caller
// has put the placeholder in the prompt: the host process's own
// connection answers synchronously, and an answer before the
// placeholder is there would have nothing to replace (task qy).

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { attachments } from '../common/attachments.ts'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { uploads, type Settled } from '../common/uploads.ts'
import type { KeyEvent } from './keys.ts'

// A dropped file as a terminal pastes it (maybe quoted, spaces escaped,
// or ~/) as a plain path.
function path(token: string): string {
	let p = token.trim()
	let quoted = /^(['"])(.*)\1$/.exec(p)
	p = quoted ? quoted[2]! : p.replace(/\\(.)/g, '$1')
	return p.startsWith('~/') ? homedir() + p.slice(1) : p
}

// The paths of several files dropped at once, as the terminal pasted
// them (one line, separated by spaces), or undefined unless every one is
// an existing file: ordinary text with spaces is never split.
function files(text: string): string[] | undefined {
	if (text.includes('\n')) return undefined
	let token = /'[^']*'|"[^"]*"|(?:\\.|[^\s\\'"])+/g
	let tokens = text.match(token)
	if (!tokens || tokens.length < 2 || text.replace(token, '').trim()) return undefined
	let exists = (t: string) => { let p = paste.path(t); return p.startsWith('/') && !!statSync(p, { throwIfNoEntry: false })?.isFile() }
	return tokens.every(exists) ? tokens : undefined
}

// The image or text file a pasted single path names, or undefined:
// its bytes, or the error text to paste instead. A 'text' file that is
// not UTF-8 (or holds NUL bytes) stays a path.
function file(text: string): { mediaType: string; bytes: Uint8Array } | { error: string } | undefined {
	if (!text.trim() || text.includes('\n')) return undefined
	let p = paste.path(text)
	let mediaType = attachments.fileKind(p.slice(p.lastIndexOf('/') + 1))
	if (!mediaType || !p.startsWith('/')) return undefined
	let stat = statSync(p, { throwIfNoEntry: false })
	if (!stat?.isFile()) return undefined
	// Not read at all if it is too large to send.
	let big = uploads.tooBig(stat.size)
	if (big) return { error: big }
	let bytes: Uint8Array
	try {
		bytes = new Uint8Array(readFileSync(p))
	} catch (e: any) {
		return { error: `[upload failed: ${e?.message ?? e}]` }
	}
	if (mediaType !== 'text/plain') return { mediaType, bytes }
	try {
		let text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		return text.includes('\0') ? undefined : { mediaType, bytes }
	} catch {
		return undefined
	}
}

// Sends `bytes` for session `sessionId`; the placeholder to insert.
function upload(sessionId: string, mediaType: string, bytes: Uint8Array, send: (command: unknown) => void): string {
	let big = uploads.tooBig(bytes.length)
	if (big) return big
	let id = connection.nextId()
	let placeholder = uploads.begin(sessionId, id, mediaType)
	let command = uploads.command(sessionId, id, mediaType, bytes)
	queueMicrotask(() => send(command))
	return placeholder
}

// A paste key as the editor should get it: an image or text file's path
// or a long text replaced by the placeholder of its upload; of several
// dropped files, each image or text file replaced and the other paths
// kept; anything else unchanged.
function key(sessionId: string, k: KeyEvent, send: (command: unknown) => void): KeyEvent {
	if (k.key !== 'paste' || !k.text) return k
	let text = prompt.clean(k.text)
	let attach = (t: string): string | undefined => {
		let image = paste.file(t)
		if (image && 'error' in image) return image.error
		if (image) return paste.upload(sessionId, image.mediaType, image.bytes, send)
		return undefined
	}
	let many = paste.files(text)
	if (many) return { ...k, text: many.map((t) => attach(t) ?? t).join(' ') }
	let one = attach(text)
	if (one !== undefined) return { ...k, text: one }
	if (uploads.long(text)) return { ...k, text: paste.upload(sessionId, 'text/plain', new TextEncoder().encode(text), send) }
	return k
}

type Prompts = { transcript?: { meta: { id: string } }; prompt: PromptState; hidden: Map<string, { prompt?: PromptState }> }

// Puts the host's answer to an upload in place of its placeholder: in
// the prompt shown or kept for a hidden tab, and in the draft.
function settled(st: Prompts, event: Event): Settled | undefined {
	let done = uploads.settle(event)
	if (!done) return undefined
	let { sessionId: id, placeholder, text } = done
	if (st.transcript?.meta.id === id) st.prompt = uploads.swap(st.prompt, placeholder, text)
	let kept = st.hidden.get(id)
	if (kept?.prompt) kept.prompt = uploads.swap(kept.prompt, placeholder, text)
	let draft = drafts.text(id)
	if (draft.includes(placeholder)) drafts.edit(id, draft.replace(placeholder, () => text))
	return done
}

export const paste = { path, files, file, upload, key, settled }
