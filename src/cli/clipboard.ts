// Clipboard access — sync, macOS only.

import { mkdirSync, existsSync } from 'fs'

const IMAGE_DIR = '/tmp/hal/images'

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
