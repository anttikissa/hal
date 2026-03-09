// Clipboard access — sync, macOS only.

import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'fs'

const IMAGE_DIR = '/tmp/hal/images'
const PASTE_DIR = '/tmp/hal/paste'
const MAX_INLINE_NEWLINES = 5

function ensureDir(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

/** Save clipboard image to temp file, return path or null. */
export function getClipboardImage(): string | null {
	if (process.platform !== 'darwin') return null
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
	const proc = Bun.spawnSync(['osascript', '-e', script])
	const stdout = proc.stdout.toString().trim()
	return stdout === 'no-image' ? null : stdout
}

function readClipboardText(): string {
	try { return Bun.spawnSync(['pbpaste']).stdout.toString() } catch { return '' }
}

/** Read clipboard: image path as `[path]`, or text. */
export function pasteFromClipboard(): string {
	const imagePath = getClipboardImage()
	if (imagePath) return `[${imagePath}]`
	return readClipboardText()
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

/** Normalize pasted text: fix line endings, strip control chars.
 *  If >5 newlines, save to file and return `[path]` instead. */
export function cleanPaste(raw: string): string {
	const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
	if (!text) return ''
	const newlineCount = (text.match(/\n/g) || []).length
	if (newlineCount > MAX_INLINE_NEWLINES) return saveMultilinePaste(text)
	return text
}
