import { afterEach, expect, test } from 'bun:test'
import { bash } from './bash.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const originalMaxOutputBytes = bash.config.maxOutputBytes

afterEach(() => {
	bash.config.maxOutputBytes = originalMaxOutputBytes
})

test('bash caps noisy stdout while draining the command', async () => {
	bash.config.maxOutputBytes = 2000

	const out = await bash.execute(
		{ command: "printf '%*s' 10000 '' | tr ' ' x" },
		{ sessionId: 's', cwd: process.cwd() },
	)

	expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2000)
	expect(out.endsWith('\n[… truncated]')).toBe(true)
})

test('bash strips redundant cd prefix after normalizing cwd', () => {
	expect(bash.stripCdCwd('cd /tmp/../tmp && pwd', '/tmp/')).toBe('pwd')
	expect(bash.stripCdCwd('cd /var && pwd', '/tmp')).toBe('cd /var && pwd')
})

test('bash appends structured metadata for successful git commits', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-bash-commit-'))
	try {
		Bun.spawnSync(['git', 'init'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
		Bun.spawnSync(['git', 'config', 'user.email', 'a@test.com'], { cwd: dir })
		Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir })
		writeFileSync(join(dir, 'a.ts'), 'const x = 1\n// comment\n')
		const out = await bash.execute(
			{ command: 'git add a.ts && git commit -m "add a"' },
			{ sessionId: 's', cwd: dir },
		)

		expect(out).toContain('[hal-commit]')
		expect(out).toContain("message: 'add a'")
		expect(out).toContain('summary: \'1 file changed, 2 insertions(+)\'')
		expect(out).toContain("path: 'a.ts'")
		expect(out).toContain('locDelta: 1')
		expect(out).toContain('locDeltaCode: 1')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})


test('bash commit metadata reports net loc delta', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hal-bash-commit-net-'))
	try {
		Bun.spawnSync(['git', 'init'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
		Bun.spawnSync(['git', 'config', 'user.email', 'a@test.com'], { cwd: dir })
		Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir })
		writeFileSync(join(dir, 'a.ts'), 'const x = 1\n')
		Bun.spawnSync(['git', 'add', 'a.ts'], { cwd: dir })
		Bun.spawnSync(['git', 'commit', '-m', 'initial'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
		writeFileSync(join(dir, 'a.ts'), 'const y = 2\n')

		const out = await bash.execute(
			{ command: 'git add a.ts && git commit -m "replace a"' },
			{ sessionId: 's', cwd: dir },
		)

		expect(out).toContain('locDelta: 0')
		expect(out).toContain('locDeltaCode: 0')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
