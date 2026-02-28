import { describe, test, expect } from 'bun:test'
import { mkdirSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { startHal } from './tests/helpers/harness.ts'

describe('debug log retention', () => {
	test('prunes debug+bugs to configured maxDiskBytes', async () => {
		const chunk = 'x'.repeat(2 * 1024 * 1024)

		const config = `{
			model: 'anthropic/claude-opus-4-6',
			debug: {
				recordEverything: true,
				maxDiskBytes: 6291456
			}
		}
`

		const hal = await startHal({
			config,
			env: { HAL_WEB_PORT: String(20000 + Math.floor(Math.random() * 20000)) },
			setup: ({ stateDir }) => {
				const debugDir = join(stateDir, 'debug')
				const bugsDir = join(stateDir, 'bugs')
				mkdirSync(debugDir, { recursive: true })
				mkdirSync(bugsDir, { recursive: true })
				for (let i = 0; i < 2; i++) {
					writeFileSync(join(debugDir, `old-${i}.asonl`), chunk)
					writeFileSync(join(bugsDir, `old-${i}.asonl`), chunk)
				}
			}
		})

		try {
			await hal.waitForReady()
			await Bun.sleep(400)

			const debugDir = join(hal.halDir, 'state', 'debug')
			const bugsDir = join(hal.halDir, 'state', 'bugs')
			let total = 0
			for (const dir of [debugDir, bugsDir]) {
				const entries = [...new Bun.Glob('*.asonl').scanSync({ cwd: dir })]
				for (const entry of entries) total += statSync(join(dir, entry)).size
			}
			expect(total).toBeLessThanOrEqual(6 * 1024 * 1024)
		} finally {
			await hal.stop()
		}
	})
})
