import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { HAL_DIR } from '../state.ts'
import { bash } from './bash.ts'
import { evalTool } from './eval.ts'
import { glob } from './glob.ts'
import { grep } from './grep.ts'
import { read } from './read.ts'
import { sensitive } from './sensitive.ts'
import { write } from './write.ts'

const TEST_DIR = '/tmp/hal-test-sensitive-tools'
const protectedPath = join(HAL_DIR, 'auth.ason')

afterEach(() => {
	if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
})

test('read refuses the protected auth file without reading it', async () => {
	const out = await read.execute({ path: 'auth.ason' }, { sessionId: 's', cwd: HAL_DIR })
	expect(out).toContain('refusing to read protected credentials file')
	expect(out).toContain(protectedPath)
})

test('write and edit refuse the protected auth file before opening it', async () => {
	const writeOut = await write.executeWrite({ path: 'auth.ason', content: 'x' }, { sessionId: 's', cwd: HAL_DIR })
	const editOut = await write.executeEdit({ path: 'auth.ason', operation: 'insert', after_ref: '0:000', new_content: 'x' }, { sessionId: 's', cwd: HAL_DIR })

	expect(writeOut).toContain('refusing to write protected credentials file')
	expect(editOut).toContain('refusing to edit protected credentials file')
})

test('grep and glob hide auth-shaped files from directory searches', async () => {
	mkdirSync(TEST_DIR, { recursive: true })
	writeFileSync(join(TEST_DIR, 'auth.ason'), 'needle\n')
	writeFileSync(join(TEST_DIR, 'public.txt'), 'needle\n')

	const grepOut = await grep.execute({ pattern: 'needle', path: TEST_DIR }, { sessionId: 's', cwd: TEST_DIR })
	const globOut = await glob.execute({ pattern: '*', path: TEST_DIR }, { sessionId: 's', cwd: TEST_DIR })

	expect(grepOut).toContain('public.txt')
	expect(grepOut).not.toContain('auth.ason')
	expect(globOut).toContain('public.txt')
	expect(globOut).not.toContain('auth.ason')
})

test('direct grep and glob attempts for protected auth are refused', async () => {
	const grepOut = await grep.execute({ pattern: 'anything', path: 'auth.ason' }, { sessionId: 's', cwd: HAL_DIR })
	const globOut = await glob.execute({ pattern: 'auth.ason', path: HAL_DIR }, { sessionId: 's', cwd: HAL_DIR })

	expect(grepOut).toContain('refusing to search protected credentials file')
	expect(globOut).toContain('refusing to list protected credentials file')
})

test('bash refuses obvious auth access requests before spawning a shell', async () => {
	const out = await bash.execute({ command: 'printf auth.ason' }, { sessionId: 's', cwd: HAL_DIR })

	expect(out).toContain('refusing to run command that mentions protected credentials file')
})

test('eval refuses obvious auth access code', async () => {
	const out = await evalTool.execute({ code: `return Bun.file('${protectedPath}').text()` }, { sessionId: 's', cwd: HAL_DIR })

	expect(out).toContain('refusing to run eval code that mentions protected credentials access')
})

test('sensitive shell profile denies the protected path when present without reading it', () => {
	const profile = sensitive.shellProfile()
	if (!profile) return

	expect(profile).toContain('(deny file-read*')
	expect(profile).toContain(protectedPath)
})
