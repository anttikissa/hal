// Attachments and pasted files served over the web: blobs, image and
// paste pages, raw bytes and file-address logins.

import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { paths } from './paths.ts'
import { server } from './server.ts'
import { sessions } from './sessions.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'
import { testHome, useWeb, base, cookie } from './web-fixture.test.ts'

useWeb()

test('GET /blob serves a session’s attachment by exact id, with the cookie only', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: testHome() }).id
	let other = sessions.create({ cwd: testHome() }).id
	let png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])
	let { blob } = blobs.store(id, 'image/png', png.toString('base64'))
	let jar = await cookie()
	let get = (path: string, auth = true) => fetch(`${base()}${path}`, { headers: auth ? { cookie: jar } : {} })

	let res = await get(`/blob/${id}/${blob}`)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toBe('image/png')
	expect(Buffer.from(await res.arrayBuffer())).toEqual(png)

	expect((await get(`/blob/${id}/${blob}`, false)).status).toBe(401)
	expect((await get(`/blob/${other}/${blob}`)).status).toBe(404)
	expect((await get(`/blob/${id}/${blob.slice(0, -1)}`)).status).toBe(404)
	expect((await get(`/blob/${id}/${blob}.png`)).status).toBe(404)
	for (let path of [
		`/blob/${id}/..%2f..%2fconfig.ason`,
		`/blob/${id}/%2e%2e`,
		`/blob/${id}/blobs%2f${blob}`,
		`/blob/..%2f${id}/${blob}`,
		`/blob/${id}/${blob}/x`,
	]) {
		expect((await get(path)).status).toBe(404)
	}
})

test('GET /image/<name> is a page naming where the image lives; /raw/<name> its bytes, from /tmp or once gone from its session blob', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: testHome() }).id
	let png = Buffer.concat([
		Buffer.from('89504e470d0a1a0a0000000d4948445200000138000000d8', 'hex'),
		Buffer.from('pixels'),
	])
	blobs.stage('abc123.png', 'image/png', png.toString('base64'))
	let jar = await cookie()
	let get = (path: string, auth = true) => fetch(`${base()}${path}`, { headers: auth ? { cookie: jar } : {} })
	let tmp = `${paths.imageDir()}/abc123.png`

	expect((await get('/image/abc123', false)).status).toBe(401)
	expect((await get('/image/abc123.png', false)).status).toBe(401)
	expect((await get('/raw/abc123.png', false)).status).toBe(401)
	let page = await (await get('/image/abc123.png')).text()
	expect(page).toContain(tmp)
	expect(page).toContain('src="/raw/abc123.png"')
	expect(page).toContain(`<code>${tmp}</code> (312 × 216, 30 B)`)
	expect(page).toContain('href="/raw/abc123.png" download="abc123.png"')
	expect(page).toContain('>Open original</a>')
	expect((await get('/image/abc123')).status).toBe(200)
	let larger = Buffer.concat([png, Buffer.alloc(1_234_567 - png.length)])
	blobs.stage('def456.png', 'image/png', larger.toString('base64'))
	expect(await (await get('/image/def456')).text()).toContain('1.2 MB')
	blobs.stage('abc123.jpg', 'image/jpeg', Buffer.from('ffd8ff', 'hex').toString('base64'))
	expect((await get('/image/abc123')).status).toBe(404)
	expect((await get('/image/abc123.png')).status).toBe(200)
	rmSync(`${paths.imageDir()}/abc123.jpg`)
	let res = await get('/raw/abc123.png')
	expect(res.headers.get('content-type')).toBe('image/png')
	expect(Buffer.from(await res.arrayBuffer())).toEqual(png)

	expect(blobs.resolve(id, ['[image/abc123.png]']).unknown).toEqual([])
	let copy = `${paths.sessionDir(id)}/blobs/abc123.png`
	expect(await (await get('/image/abc123.png')).text()).toContain(copy)
	rmSync(tmp)
	page = await (await get('/image/abc123.png')).text()
	expect(page).toContain(copy)
	expect(page).not.toContain(tmp)
	expect(Buffer.from(await (await get('/raw/abc123.png')).arrayBuffer())).toEqual(png)
	expect((await get(`/blob/${id}/abc123`)).status).toBe(200)
	for (let path of [
		'/image/abc123.jpg',
		'/image/zzz999.png',
		'/image/..%2fabc123.png',
		'/image/abc123.png/x',
		'/paste/abc123.png',
		'/raw/abc123',
	]) {
		expect((await get(path)).status).toBe(404)
	}
})

test('a pasted long text lands at the stated /tmp path; its page names that path and shows the text escaped', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: testHome() }).id
	let text = 'line 1 <b>&amp;</b>\nline 2\n'
	let stored = blobs.stage('0005ab.txt', 'text/plain', Buffer.from(text).toString('base64'))
	expect(stored.marker).toBe('[paste/0005ab.txt]')
	let tmp = `${paths.tmpDir()}/paste/0005ab.txt`
	expect(readFileSync(tmp, 'utf8')).toBe(text)
	let jar = await cookie()
	let get = (path: string) => fetch(`${base()}${path}`, { headers: { cookie: jar } })
	let page = await (await get('/paste/0005ab.txt')).text()
	expect(page).toContain(tmp)
	expect(page).toContain('line 1 &#60;b&#62;&#38;amp;&#60;/b&#62;\nline 2')
	expect(await (await get('/raw/0005ab.txt')).text()).toBe(text)
	expect((await get('/image/0005ab.txt')).status).toBe(404)
	// The model gets the text itself; the session keeps its own copy.
	expect(blobs.resolve(id, ['see [paste/0005ab.txt]'])).toEqual({
		blocks: [{ type: 'text', text: 'see [paste/0005ab.txt]' }],
		unknown: [],
	})
	expect(blobs.expand(id, 'see [paste/0005ab.txt]')).toBe(`see ${text}`)
	expect(await (await get('/paste/0005ab.txt')).text()).toContain(`${paths.sessionDir(id)}/blobs/0005ab.txt`)
})

test('binary file page previews no bytes and raw download is safe', async () => {
	await server.serve()
	web.start()
	let file = blobs.stage('a1b2c3.pdf', 'application/octet-stream', Buffer.from([0, 255, 60, 88]).toString('base64'))
	expect(file.marker).toBe('[file/a1b2c3.pdf]')
	let jar = await cookie()
	let get = (path: string) => fetch(`${base()}${path}`, { headers: { cookie: jar } })
	let page = await (await get('/file/a1b2c3.pdf')).text()
	expect(page).toContain(`${paths.tmpDir()}/file/a1b2c3.pdf`)
	expect(page).toContain('Binary file')
	expect(page).not.toContain('&#60;X')
	let raw = await get('/raw/a1b2c3.pdf')
	expect(raw.headers.get('content-disposition')).toContain('attachment')
	expect(raw.headers.get('x-content-type-options')).toBe('nosniff')
	expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array([0, 255, 60, 88]))
	expect((await get('/image/a1b2c3.pdf')).status).toBe(404)
})

test('a shared file under fileDir: HTML as itself with its own assets, others on a page, raw bytes, no escape', async () => {
	await server.serve()
	web.start()
	let dir = `${paths.fileDir()}/test-app`
	mkdirSync(dir, { recursive: true })
	writeFileSync(`${dir}/index.html`, '<link rel="stylesheet" href="style.css"><p>hi')
	writeFileSync(`${dir}/style.css`, 'p { color: red }')
	writeFileSync(`${paths.fileDir()}/notes-1.md`, '# <b>')
	let jar = await cookie()
	let get = (path: string, dest?: string) =>
		fetch(`${base()}${path}`, { headers: { cookie: jar, ...(dest ? { 'sec-fetch-dest': dest } : {}) } })
	let html = await get('/file/test-app/index.html', 'document')
	expect(html.headers.get('content-type')).toContain('text/html')
	expect(await html.text()).toBe('<link rel="stylesheet" href="style.css"><p>hi')
	let css = await get('/file/test-app/style.css', 'style')
	expect(css.headers.get('content-type')).toContain('text/css')
	expect(await css.text()).toBe('p { color: red }')
	let page = await (await get('/file/notes-1.md', 'document')).text()
	expect(page).toContain(`${paths.fileDir()}/notes-1.md`)
	expect(page).toContain('# &#60;b&#62;')
	expect(page).toContain('href="/raw/notes-1.md"')
	expect(await (await get('/raw/notes-1.md')).text()).toBe('# <b>')
	expect((await fetch(`${base()}/file/notes-1.md`)).status).toBe(401)
	expect(await (await get('/file/test-app/', 'document')).text()).toBe('<link rel="stylesheet" href="style.css"><p>hi')
	let moved = await fetch(`${base()}/file/test-app`, { headers: { cookie: jar }, redirect: 'manual' })
	expect([moved.status, moved.headers.get('location')]).toEqual([301, '/file/test-app/'])
	mkdirSync(`${paths.fileDir()}/shots/sub`, { recursive: true })
	writeFileSync(`${paths.fileDir()}/shots/a.png`, '')
	writeFileSync(`${paths.fileDir()}/shots/.hidden`, '')
	expect(await (await get('/file/shots/')).text()).toContain(
		'<li><a href="a.png">a.png</a></li><li><a href="sub/">sub/</a></li></ul>',
	)
	for (let path of [
		'/file/../config.ason',
		'/file/%2e%2e/x',
		'/file/.hidden',
		'/file/test-app/../x',
		'/file/a/',
		'/file/notes-1.md/',
	])
		expect((await get(path)).status).toBe(404)
})

test('a file address takes a link code; a used or expired one gets the gate, which leads back there', async () => {
	await server.serve()
	web.start()
	let now = Date.now()
	let origNow = clock.now
	clock.now = () => now
	try {
		let png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.from('pixels')])
		blobs.stage('abc123.png', 'image/png', png.toString('base64'))
		let open = (path: string, cookie?: string) =>
			fetch(`${base()}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} })
		let gate = async (res: Response) => {
			expect(res.status).toBe(401)
			expect(res.headers.get('content-type')).toContain('text/html')
			expect(res.headers.get('cache-control')).toBe('no-store')
			expect(await res.text()).toContain('</html>')
		}
		let code = webAuth.issue()
		let first = await open(`/image/abc123.png?auth=${code}`)
		expect(first.status).toBe(303)
		expect(first.headers.get('location')).toBe('/image/abc123.png')
		let jar = first.headers.get('set-cookie')!.split(';')[0]!
		expect(await (await open('/image/abc123.png', jar)).text()).toContain('/raw/abc123.png')
		// Clicked again in another browser: used, so no cookie, and the
		// address it lands on shows the gate.
		let again = await open(`/image/abc123.png?auth=${code}`)
		expect(again.headers.get('location')).toBe('/image/abc123.png')
		expect(again.headers.get('set-cookie')).toBeNull()
		await gate(await open('/image/abc123.png'))
		let late = webAuth.issue()
		now += 10 * 60_000
		expect((await open(`/image/abc123.png?auth=${late}`)).headers.get('set-cookie')).toBeNull()
		await gate(await open(`/blob/1-abc/abc123`))
		// The API still answers a bare 401.
		expect((await open('/login')).status).toBe(401)
	} finally {
		clock.now = origNow
	}
})

test('POST /upload streams files with cookie, same-origin, type and size checks', async () => {
	await server.serve()
	web.start()
	let id = sessions.create({ cwd: testHome() }).id
	let jar = await cookie()
	let post = (name: string, body: BodyInit, headers: Record<string, string> = {}) =>
		fetch(`${base()}/upload?name=${encodeURIComponent(name)}&session=${id}`, {
			method: 'POST',
			headers: { cookie: jar, origin: base(), ...headers },
			body,
		})

	expect((await fetch(`${base()}/upload?name=abc123.mov`, { method: 'POST', body: 'x' })).status).toBe(401)
	expect((await post('abc123.mov', 'x', { origin: 'https://evil.example' })).status).toBe(403)
	expect((await post('../bad.mov', 'x')).status).toBe(400)
	expect((await post('abc123.png', 'not a png')).status).toBe(400)
	expect((await post('abc123.mov', '')).status).toBe(400)

	// Binary files above the 5 MB image cap stream straight to disk and resolve on submit.
	let mov = new Uint8Array(6 * 1024 * 1024)
	mov.set([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70])
	let ok = await post('vid001.mov', mov)
	expect(ok.status).toBe(200)
	expect(await ok.json()).toEqual({ blob: 'vid001', marker: '[file/vid001.mov]' })
	expect((await post('vid001.mov', mov)).status).toBe(200)
	expect((await post('vid001.mov', new Uint8Array([1, 2, 3]))).status).toBe(400)
	expect(blobs.resolve(id, ['watch [file/vid001.mov]']).unknown).toEqual([])
	expect(readFileSync(`${paths.sessionDir(id)}/blobs/vid001.mov`).length).toBe(mov.length)

	// Images stay capped at 5 MB; binary files over 50 MB are rejected with 413.
	let png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(5 * 1024 * 1024)])
	expect((await post('big001.png', png)).status).toBe(413)
	expect((await post('big002.mov', new Uint8Array(50 * 1024 * 1024 + 1))).status).toBe(413)
})
