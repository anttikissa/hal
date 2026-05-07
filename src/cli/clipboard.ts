// Clipboard access. macOS uses Bun FFI directly into AppKit's NSPasteboard
// (no spawn, ~ms). Linux shells out to wl-paste/xclip. Windows: text only.

import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { ensureDir } from '../state.ts'

const IMAGE_DIR = '/tmp/hal/images'
const PASTE_DIR = '/tmp/hal/paste'

const config = {
	// Multiline pasted text with more than this many lines is written to
	// /tmp/hal/paste/NNNN.txt and represented in the prompt as [path]. Pastes at
	// or below the limit stay inline. Read at paste time so /config takes effect.
	multilinePasteFileLineLimit: 5,
}

// ── macOS clipboard via Bun FFI ──────────────────────────────────────────────
// We talk to the Objective-C runtime directly: objc_getClass, sel_registerName,
// objc_msgSend. AppKit must be dlopen'd so the NSPasteboard class is visible.
// We need three objc_msgSend variants because Bun FFI requires distinct symbol
// declarations for different argument signatures.

type MacFFI = {
	send0: (cls: number, sel: number) => number // [obj selector]
	send1: (obj: number, sel: number, a1: number) => number // [obj selector:a1]
	sendU64: (obj: number, sel: number) => bigint // [obj selector] returning NSUInteger
	cls: (name: string) => number
	sel: (name: string) => number
	nsstring: (s: string) => number
}
let mac: MacFFI | null = null
let macTried = false

function loadMac(): MacFFI | null {
	if (macTried) return mac
	macTried = true
	if (process.platform !== 'darwin') return null
	try {
		const objc = dlopen('/usr/lib/libobjc.A.dylib', {
			objc_getClass: { args: [FFIType.cstring], returns: FFIType.pointer },
			sel_registerName: { args: [FFIType.cstring], returns: FFIType.pointer },
		})
		const send0 = dlopen('/usr/lib/libobjc.A.dylib', {
			objc_msgSend: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.pointer },
		}).symbols.objc_msgSend
		const send1 = dlopen('/usr/lib/libobjc.A.dylib', {
			objc_msgSend: { args: [FFIType.pointer, FFIType.pointer, FFIType.pointer], returns: FFIType.pointer },
		}).symbols.objc_msgSend
		const sendU64 = dlopen('/usr/lib/libobjc.A.dylib', {
			objc_msgSend: { args: [FFIType.pointer, FFIType.pointer], returns: FFIType.u64 },
		}).symbols.objc_msgSend
		// AppKit dlopen registers NSPasteboard etc. with the Obj-C runtime.
		// We don't call NSApplicationLoad ourselves; declaring it just gives
		// dlopen a symbol to bind so the framework gets loaded.
		dlopen('/System/Library/Frameworks/AppKit.framework/AppKit', {
			NSApplicationLoad: { args: [], returns: FFIType.bool },
		})
		const clsCache = new Map<string, number>()
		const selCache = new Map<string, number>()
		const cls = (name: string): number => {
			let v = clsCache.get(name)
			if (v === undefined) {
				v = objc.symbols.objc_getClass(Buffer.from(name + '\0')) as number
				clsCache.set(name, v)
			}
			return v
		}
		const sel = (name: string): number => {
			let v = selCache.get(name)
			if (v === undefined) {
				v = objc.symbols.sel_registerName(Buffer.from(name + '\0')) as number
				selCache.set(name, v)
			}
			return v
		}
		const nsstring = (s: string): number => {
			const buf = Buffer.from(s + '\0')
			return (send1 as any)(cls('NSString'), sel('stringWithUTF8String:'), ptr(buf)) as number
		}
		mac = { send0: send0 as any, send1: send1 as any, sendU64: sendU64 as any, cls, sel, nsstring }
		return mac
	} catch {
		return null
	}
}

function getClipboardImageMac(): Buffer | null {
	const m = loadMac()
	if (!m) return null
	const pb = m.send0(m.cls('NSPasteboard'), m.sel('generalPasteboard'))
	if (!pb) return null
	// Try public.png first (most apps, screenshots). Some apps (e.g. Preview
	// copy) only put public.tiff -- in that case we let NSBitmapImageRep
	// transcode to PNG for us.
	let data = m.send1(pb, m.sel('dataForType:'), m.nsstring('public.png'))
	if (!data) {
		const tiff = m.send1(pb, m.sel('dataForType:'), m.nsstring('public.tiff'))
		if (!tiff) return null
		// [[NSBitmapImageRep alloc] initWithData:tiff]
		const allocRep = m.send0(m.cls('NSBitmapImageRep'), m.sel('alloc'))
		const rep = m.send1(allocRep, m.sel('initWithData:'), tiff)
		if (!rep) return null
		// [rep representationUsingType:NSPNGFileType=4 properties:nil]
		const sendNSBitmap = dlopen('/usr/lib/libobjc.A.dylib', {
			objc_msgSend: { args: [FFIType.pointer, FFIType.pointer, FFIType.u64, FFIType.pointer], returns: FFIType.pointer },
		}).symbols.objc_msgSend as any
		data = sendNSBitmap(rep, m.sel('representationUsingType:properties:'), 4n, 0)
		if (!data) return null
	}
	const len = Number(m.sendU64(data, m.sel('length')))
	if (!len) return null
	const bytesPtr = m.send0(data, m.sel('bytes'))
	const ab = toArrayBuffer(bytesPtr as any, 0, len)
	return Buffer.from(new Uint8Array(ab)) // copy out of NSData-backed memory
}

// ── Linux clipboard via wl-paste / xclip ─────────────────────────────────────

function getClipboardImageLinux(): Buffer | null {
	const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
	if (wayland) {
		const r = Bun.spawnSync(['wl-paste', '--type', 'image/png', '--no-newline'], { stderr: 'ignore' })
		if (r.exitCode === 0 && r.stdout.length > 0) return Buffer.from(r.stdout)
		return null
	}
	const r = Bun.spawnSync(['xclip', '-selection', 'clipboard', '-t', 'image/png', '-o'], { stderr: 'ignore' })
	if (r.exitCode === 0 && r.stdout.length > 0) return Buffer.from(r.stdout)
	return null
}

function getClipboardImage(): Buffer | null {
	if (process.platform === 'darwin') return getClipboardImageMac()
	if (process.platform === 'linux') return getClipboardImageLinux()
	return null
}

function readClipboardText(): string {
	try {
		if (process.platform === 'darwin') return Bun.spawnSync(['pbpaste']).stdout.toString()
		if (process.platform === 'linux') {
			const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
			const cmd = wayland ? ['wl-paste', '--no-newline'] : ['xclip', '-selection', 'clipboard', '-o']
			const r = Bun.spawnSync(cmd, { stderr: 'ignore' })
			return r.exitCode === 0 ? r.stdout.toString() : ''
		}
		return ''
	} catch {
		return ''
	}
}

// Read clipboard. Returns text to insert directly (image -> "[path]").
function pasteFromClipboard(): string {
	const text = readClipboardText()
	if (text) return text
	const image = getClipboardImage()
	if (!image) return ''
	ensureDir(IMAGE_DIR)
	const path = `${IMAGE_DIR}/${Math.random().toString(36).slice(2, 8)}.png`
	writeFileSync(path, image)
	return `[${path}]`
}

function saveMultilinePaste(text: string): string {
	ensureDir(PASTE_DIR)
	const existing = readdirSync(PASTE_DIR)
		.filter((f) => /^\d{4}\.txt$/.test(f))
		.map((f) => parseInt(f.slice(0, 4), 10))
	const next = existing.length > 0 ? Math.max(...existing) + 1 : 1
	const path = `${PASTE_DIR}/${String(next).padStart(4, '0')}.txt`
	writeFileSync(path, text)
	return `[${path}]`
}

function lineCount(text: string): number {
	return text.split('\n').length
}

function shouldSaveMultilinePaste(text: string): boolean {
	if (!text.includes('\n')) return false
	return lineCount(text) > config.multilinePasteFileLineLimit
}

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp)$/i

// Normalize pasted text: fix line endings, strip control chars.
// Single-line image path -> wrap in [brackets]. The prompt module decides
// whether multiline text is displayed inline or saved to /tmp/hal/paste.
function cleanPaste(raw: string): string {
	const text = raw
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
	if (!text) return ''
	const trimmed = text.trim()
	if (trimmed.startsWith('/') && !trimmed.includes('\n') && IMAGE_EXTS.test(trimmed) && existsSync(trimmed)) {
		return `[${trimmed.replace(homedir(), '~')}]`
	}
	return text
}

export const clipboard = { config, pasteFromClipboard, cleanPaste, saveMultilinePaste, shouldSaveMultilinePaste }
