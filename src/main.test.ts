import { expect, test } from 'bun:test'

test('./run starts the app', () => {
	let out = Bun.spawnSync(['./run'], { cwd: `${import.meta.dir}/..` })
	expect(out.exitCode).toBe(0)
	expect(out.stdout.toString()).toBe('hal2\n')
})
