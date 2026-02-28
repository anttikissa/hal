import { mkdirSync, existsSync, readdirSync, writeFileSync } from 'fs'

const IMAGE_DIR = '/tmp/hal/images', PASTE_DIR = '/tmp/hal/paste'
function ensureDir(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) }

async function getClipboardImage(): Promise<string | null> {
	if (process.platform !== 'darwin') return null
	const path = `${IMAGE_DIR}/${Math.random().toString(36).slice(2, 8)}.png`
	ensureDir(IMAGE_DIR)
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
	const stdout = await new Response(proc.stdout).text()
	await proc.exited
	return stdout.trim() === 'no-image' ? null : stdout.trim()
}

async function getClipboardText(): Promise<string | null> {
	if (process.platform !== 'darwin') return null
	const proc = Bun.spawn(['pbpaste'], { stdout: 'pipe', stderr: 'pipe' })
	const text = await new Response(proc.stdout).text()
	await proc.exited; return text || null
}

export async function pasteFromClipboard(): Promise<string | null> {
	const imagePath = await getClipboardImage()
	return imagePath ? `[${imagePath}]` : getClipboardText()
}

export function saveMultilinePaste(text: string): string {
	ensureDir(PASTE_DIR)
	const existing = readdirSync(PASTE_DIR).filter((f) => /^\d{4}\.txt$/.test(f)).map((f) => parseInt(f.slice(0, 4), 10))
	const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
	const path = `${PASTE_DIR}/${String(next).padStart(4, '0')}.txt`
	writeFileSync(path, text); return `[${path}]`
}