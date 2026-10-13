import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { history } from './history.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { sessions } from './sessions.ts'
import { stats } from './stats.ts'
import { web } from './web.ts'
import { webAuth } from './web-auth.ts'

let home = '', id = ''
let saved = process.env.HAL_HOME
beforeEach(() => {
	home = mkdtempSync(`${tmpdir()}/hal-context-`)
	process.env.HAL_HOME = home
	paths.init()
	id = sessions.create({ cwd: home }).id
})
afterEach(async () => {
	await web.stop()
	host.reset()
	sessions.closeAll()
	if (saved === undefined) delete process.env.HAL_HOME
	else process.env.HAL_HOME = saved
	rmSync(home, { recursive: true, force: true })
})

test('the graph page needs login, links each round to its block, and rounds are pushed as they finish', async () => {
	let usage = { input: 100, cacheRead: 900 }
	history.append(id, { type: 'user', blocks: [{ type: 'text', text: 'hi' }] })
	history.append(id, { type: 'round', usage, block: 2 })
	let server = { timeout() {} } as any
	let route = `http://localhost/context/${id}`
	expect((await web.fetch(new Request(route), server))!.status).toBe(401)
	let token = webAuth.redeem(webAuth.issue())
	if (!('token' in token)) throw new Error('login failed')
	let headers = { cookie: `hal=${token.token}` }
	let res = await web.fetch(new Request(route, { headers }), server)
	let html = await res!.text()
	expect(html).toContain(`href="/${id}#2"`)
	expect(html).toContain('1000 tokens')
	expect((await web.fetch(new Request(`http://localhost/context/9999-zzz`, { headers }), server))!.status).toBe(404)

	let events = await web.fetch(new Request(`${route}/events`, { headers }), server)
	let reader = events!.body!.getReader()
	let read = async () => new TextDecoder().decode((await reader.read()).value)
	expect(await read()).toContain(`#2`)
	history.append(id, { type: 'round', usage, block: 3 })
	stats.round(id, usage)
	expect(await read()).toContain(`#3`)
	await reader.cancel()
})
