// Pastes that become attachments in the terminal (task zc): an image on
// the clipboard (Ctrl-V), a pasted line that is the path of an image
// file, and text longer than settings.pasteLines(). Each is sent with an
// `attach` command and stands in the prompt as a placeholder until the
// host answers (common/uploads.ts).

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { connection } from '../common/connection.ts'
import { drafts } from '../common/drafts.ts'
import type { Event } from '../common/protocol.ts'
import { prompt, type PromptState } from '../common/prompt.ts'
import { uploads, type Settled } from '../common/uploads.ts'
import type { KeyEvent } from './keys.ts'

const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// The image file a pasted single line names (as a terminal pastes a
// dropped file: maybe quoted, spaces escaped, or ~/), or undefined.
// Its bytes, or the error text to paste instead.
function file(text: string): { mediaType: string; bytes: Uint8Array } | { error: string } | undefined {
	let path = text.trim()
	if (!path || path.includes('\n')) return undefined
	let quoted = /^(['"])(.*)\1$/.exec(path)
	path = quoted ? quoted[2]! : path.replace(/\\(.)/g, '$1')
	if (path.startsWith('~/')) path = homedir() + path.slice(1)
	let mediaType = imageTypes[/\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '']
	if (!mediaType || !path.startsWith('/')) return undefined
	let stat = statSync(path, { throwIfNoEntry: false })
	if (!stat?.isFile()) return undefined
	// Not read at all if it is too large to send.
	let big = uploads.tooBig(stat.size)
	if (big) return { error: big }
	try {
		return { mediaType, bytes: new Uint8Array(readFileSync(path)) }
	} catch (e: any) {
		return { error: `[upload failed: ${e?.message ?? e}]` }
	}
}

// Sends `bytes` for session `sessionId`; the placeholder to insert.
function upload(sessionId: string, mediaType: string, bytes: Uint8Array, send: (command: unknown) => void): string {
	let big = uploads.tooBig(bytes.length)
	if (big) return big
	let id = connection.nextId()
	let placeholder = uploads.begin(sessionId, id, mediaType)
	send(uploads.command(sessionId, id, mediaType, bytes))
	return placeholder
}

// A paste key as the editor should get it: an image path or a long text
// replaced by the placeholder of its upload, anything else unchanged.
function key(sessionId: string, k: KeyEvent, send: (command: unknown) => void): KeyEvent {
	if (k.key !== 'paste' || !k.text) return k
	let text = prompt.clean(k.text)
	let image = paste.file(text)
	if (image && 'error' in image) return { ...k, text: image.error }
	if (image) return { ...k, text: paste.upload(sessionId, image.mediaType, image.bytes, send) }
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

export const paste = { file, upload, key, settled }
