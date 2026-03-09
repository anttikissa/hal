// Clipboard access — macOS only.

import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'

const IMAGE_DIR = '/tmp/hal/images'
const PASTE_DIR = '/tmp/hal/paste'
const MAX_INLINE_NEWLINES = 5

function ensureDir(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

// ── Async image probe ──

let pasteCounter = 0
let pendingPastes = 0

export function resetPasteCounter(): void { pasteCounter = 0; pendingPastes = 0 }

/** Allocate a [paste:N] placeholder for async image resolution. */
function allocPlaceholder(): string { return `[paste:${++pasteCounter}]` }

function getClipboardImageAsync(): Promise<string | null> {
	if (process.platform !== 'darwin') return Promise.resolve(null)
	ensureDir(IMAGE_DIR)
	const path = `${IMAGE_DIR}/${Math.random().toString(36).slice(2, 8)}.png`
	const script = `set tempPath to "${path}"
try
  set clipData to the clipboard as «class PNGf»
  set fileRef to open for access POSIX file tempPath with write permission
  write clipData to fileRef
  close access fileRef
  return tempPath
on error
  return "no-image"
end try`
	const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
	return new Response(proc.stdout).text().then(out => {
		const s = out.trim()
		return s === 'no-image' ? null : s
	})
}

// ── Sync text ──

function readClipboardText(): string {
	try { return Bun.spawnSync(['pbpaste']).stdout.toString() } catch { return '' }
}

// ── Public API ──

type PasteResolve = (placeholder: string, replacement: string) => void

/**
 * Read clipboard. Returns immediate text to insert.
 * If clipboard text is empty, inserts a [paste:N] placeholder and probes
 * for an image asynchronously. Calls onResolve(placeholder, result) when done.
 */
export function pasteFromClipboard(onResolve?: PasteResolve): string {
	const text = readClipboardText()
	if (text) return text

	// No text — try async image probe
	const placeholder = allocPlaceholder()
	pendingPastes++
	getClipboardImageAsync().then(imagePath => {
		pendingPastes--
		if (pendingPastes === 0) pasteCounter = 0
		if (onResolve) onResolve(placeholder, imagePath ? `[${imagePath}]` : '')
	})
	return placeholder
}

/** Save text to /tmp/hal/paste/NNNN.txt, return `[path]`. */
export function saveMultilinePaste(text: string): string {
	ensureDir(PASTE_DIR)
	const existing = readdirSync(PASTE_DIR).filter(f => /^\d{4}\.txt$/.test(f)).map(f => parseInt(f.slice(0, 4), 10))
	const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
	const path = `${PASTE_DIR}/${String(next).padStart(4, '0')}.txt`
	writeFileSync(path, text)
	return `[${path}]`
}

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp)$/i

/** Normalize pasted text: fix line endings, strip control chars.
 *  Single-line image path → wrap in [brackets].
 *  If >5 newlines, save to file and return `[path]` instead. */
export function cleanPaste(raw: string): string {
	const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
	if (!text) return ''
	// Dragged image file — single path, wrap in brackets
	const trimmed = text.trim()
	if (trimmed.startsWith('/') && !trimmed.includes('\n') && IMAGE_EXTS.test(trimmed) && existsSync(trimmed)) {
		return `[${trimmed.replace(homedir(), '~')}]`
	}
	const newlineCount = (text.match(/\n/g) || []).length
	if (newlineCount > MAX_INLINE_NEWLINES) return saveMultilinePaste(text)
	return text
}
