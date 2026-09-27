// The macOS clipboard's image as PNG, read from NSPasteboard through Bun
// FFI (task zc): public.png, or public.tiff converted by
// NSBitmapImageRep when that is all there is. AppKit is loaded on the
// first call, never at import; null whenever anything is missing.

import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'

type ObjC = {
	cls(name: string): number
	sel(name: string): number
	send0(obj: number, sel: number): number
	send1(obj: number, sel: number, a: number): number
	sendU64(obj: number, sel: number): bigint
	sendRep(obj: number, sel: number, type: bigint, props: number): number
	nsstring(s: string): number
}

const libobjc = '/usr/lib/libobjc.A.dylib'
const { pointer, u64, cstring } = FFIType

// Bun FFI needs one declaration per objc_msgSend signature.
function load(): ObjC | null {
	if (process.platform !== 'darwin') return null
	try {
		let objc = dlopen(libobjc, {
			objc_getClass: { args: [cstring], returns: pointer },
			sel_registerName: { args: [cstring], returns: pointer },
		}).symbols
		let msg = (args: FFIType[], returns: FFIType) => dlopen(libobjc, { objc_msgSend: { args, returns } }).symbols.objc_msgSend as any
		// Loading AppKit registers NSPasteboard with the runtime.
		dlopen('/System/Library/Frameworks/AppKit.framework/AppKit', { NSApplicationLoad: { args: [], returns: FFIType.bool } })
		let c = (s: string) => Buffer.from(s + '\0')
		let send1 = msg([pointer, pointer, pointer], pointer)
		let cls = (name: string) => objc.objc_getClass(c(name)) as unknown as number
		let sel = (name: string) => objc.sel_registerName(c(name)) as unknown as number
		return {
			cls,
			sel,
			send0: msg([pointer, pointer], pointer),
			send1,
			sendU64: msg([pointer, pointer], u64),
			sendRep: msg([pointer, pointer, u64, pointer], pointer),
			nsstring: (s) => send1(cls('NSString'), sel('stringWithUTF8String:'), ptr(c(s))),
		}
	} catch {
		return null
	}
}

// `name`: another pasteboard than the general one (tests).
function png(name?: string): Uint8Array | null {
	let st = pasteboard.state
	if (st.objc === undefined) st.objc = pasteboard.load()
	let m = st.objc
	if (!m) return null
	try {
		let board = m.cls('NSPasteboard')
		let pb = name ? m.send1(board, m.sel('pasteboardWithName:'), m.nsstring(name)) : m.send0(board, m.sel('generalPasteboard'))
		if (!pb) return null
		let data = m.send1(pb, m.sel('dataForType:'), m.nsstring('public.png'))
		if (!data) {
			let tiff = m.send1(pb, m.sel('dataForType:'), m.nsstring('public.tiff'))
			let rep = tiff && m.send1(m.send0(m.cls('NSBitmapImageRep'), m.sel('alloc')), m.sel('initWithData:'), tiff)
			// NSBitmapImageFileTypePNG is 4.
			data = rep && m.sendRep(rep, m.sel('representationUsingType:properties:'), 4n, 0)
		}
		if (!data) return null
		let len = Number(m.sendU64(data, m.sel('length')))
		if (!len) return null
		// Copied out of the NSData's memory.
		return new Uint8Array(toArrayBuffer(m.send0(data, m.sel('bytes')) as any, 0, len)).slice()
	} catch {
		return null
	}
}

export const pasteboard = { state: { objc: undefined as ObjC | null | undefined }, load, png }
