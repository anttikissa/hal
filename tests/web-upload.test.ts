import { expect, test, beforeAll, afterAll } from 'bun:test'
import { basename } from 'path'
import { existsSync, readFileSync, rmSync } from 'fs'
import { ensureStateDir } from '../src/server/state.ts'
import { web } from '../src/server/web.ts'
import { serverKeys } from '../src/server/server-keys.ts'

// 1x1 red PNG, same fixture the attachments tests use.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIAdUe+WQAAAABJRU5ErkJggg==', 'base64')

let controller: AbortController
let token: string
let uploadedPaths: string[] = []

beforeAll(() => {
	ensureStateDir()
	controller = new AbortController()
	web.start(0, controller.signal)
	token = serverKeys.ensureLocalToken().token
})

afterAll(() => {
	controller.abort()
	for (const path of uploadedPaths) {
		rmSync(path, { force: true })
		rmSync(`${web.uploadDir()}/${basename(path)}`, { force: true })
	}
})

function uploadUrl(auth: string): string {
	return `http://127.0.0.1:${web.state.port}/upload?auth=${auth}`
}

function imageForm(name: string, data: Blob = new Blob([PNG], { type: 'image/png' })): FormData {
	const form = new FormData()
	form.append('file', data, name)
	return form
}

test('static assets are served', async () => {
	const base = `http://127.0.0.1:${web.state.port}`
	const page = await fetch(`${base}/`)
	expect(page.status).toBe(200)
	expect(await page.text()).toContain('stylesheet')
	const css = await fetch(`${base}/styles.css`)
	expect(css.status).toBe(200)
	expect(css.headers.get('content-type')).toContain('text/css')
})

test('upload requires a valid web token', async () => {
	const response = await fetch(uploadUrl('wrong-token'), { method: 'POST', body: imageForm('shot.png') })
	expect(response.status).toBe(401)
})

test('upload returns a short temp path while keeping a state copy', async () => {
	const response = await fetch(uploadUrl(token), { method: 'POST', body: imageForm('shot.png') })
	expect(response.status).toBe(200)
	const body = await response.json() as { path?: unknown }
	expect(typeof body.path).toBe('string')
	const path = body.path as string
	uploadedPaths.push(path)
	expect(path).toMatch(/^\/tmp\/hal\/i\/[a-z0-9]{6}\.png$/)
	expect(existsSync(path)).toBe(true)
	expect(readFileSync(path).equals(PNG)).toBe(true)
	const stateCopy = `${web.uploadDir()}/${basename(path)}`
	expect(existsSync(stateCopy)).toBe(true)
	expect(readFileSync(stateCopy).equals(PNG)).toBe(true)
})

test('upload does not expose the client-supplied filename', async () => {
	const response = await fetch(uploadUrl(token), { method: 'POST', body: imageForm('../../private-screenshot.png') })
	expect(response.status).toBe(200)
	const body = await response.json() as { path?: unknown }
	const path = body.path as string
	uploadedPaths.push(path)
	expect(basename(path)).not.toContain('private-screenshot')
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
	const body = await response.json() as { path: string }
	uploadedPaths.push(body.path)
})

test('upload rejects oversized images', async () => {
	const big = new Uint8Array((web.config.maxUploadBytes ?? 8 * 1024 * 1024) + 1)
	const response = await fetch(uploadUrl(token), { method: 'POST', body: imageForm('big.png', new Blob([big], { type: 'image/png' })) })
	expect(response.status).toBe(413)
})
