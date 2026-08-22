import { expect, test, beforeAll, afterAll } from 'bun:test'
import { basename } from 'path'
import { existsSync, readFileSync } from 'fs'
import { ensureStateDir } from '../src/server/state.ts'
import { web } from '../src/server/web.ts'
import { webTokens } from '../src/server/web-tokens.ts'

// 1x1 red PNG, same fixture the attachments tests use.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAdUe+WQAAAABJRU5ErkJggg==', 'base64')

let controller: AbortController
let token: string

beforeAll(() => {
	ensureStateDir()
	controller = new AbortController()
	web.start(0, controller.signal)
	token = webTokens.ensureLocalToken().token
})

afterAll(() => controller.abort())

function uploadUrl(auth: string): string {
	return `http://127.0.0.1:${web.state.port}/upload?auth=${auth}`
}

function imageForm(name: string, data: Blob = new Blob([PNG], { type: 'image/png' })): FormData {
	const form = new FormData()
	form.append('file', data, name)
	return form
}

test('upload requires a valid web token', async () => {
	const response = await fetch(uploadUrl('wrong-token'), { method: 'POST', body: imageForm('shot.png') })
	expect(response.status).toBe(401)
})

test('upload stores the image and returns its absolute path', async () => {
	const response = await fetch(uploadUrl(token), { method: 'POST', body: imageForm('shot.png') })
	expect(response.status).toBe(200)
	const body = await response.json() as { path?: unknown }
	expect(typeof body.path).toBe('string')
	const path = body.path as string
	expect(path.startsWith(web.uploadDir())).toBe(true)
	expect(path.endsWith('.png')).toBe(true)
	expect(existsSync(path)).toBe(true)
	expect(readFileSync(path).equals(PNG)).toBe(true)
})

test('upload keeps only the basename of the client-supplied filename', async () => {
	const response = await fetch(uploadUrl(token), { method: 'POST', body: imageForm('../../evil.png') })
	expect(response.status).toBe(200)
	const body = await response.json() as { path?: unknown }
	expect(basename(body.path as string)).not.toContain('..')
})

test('upload rejects non-image files', async () => {
	const form = new FormData()
	form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt')
	const response = await fetch(uploadUrl(token), { method: 'POST', body: form })
	expect(response.status).toBe(415)
})

test('upload falls back to filename extension when Content-Type is missing', async () => {
	const form = new FormData()
	form.append('file', new Blob([PNG]), 'shot.png')
	const response = await fetch(uploadUrl(token), { method: 'POST', body: form })
	expect(response.status).toBe(200)
})

test('upload rejects oversized images', async () => {
	const big = new Uint8Array((web.config.maxUploadBytes ?? 8 * 1024 * 1024) + 1)
	const response = await fetch(uploadUrl(token), { method: 'POST', body: imageForm('big.png', new Blob([big], { type: 'image/png' })) })
	expect(response.status).toBe(413)
})
