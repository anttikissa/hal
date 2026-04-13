import { expect, test } from 'bun:test'
import { isolatedTestEnv } from './test-parallel.ts'

test('isolatedTestEnv forces HAL_STATE_DIR for spawned test processes', () => {
	const env = isolatedTestEnv('/tmp/hal-test-state-demo')
	expect(env.HAL_STATE_DIR).toBe('/tmp/hal-test-state-demo')
	expect(env.PATH).toBe(process.env.PATH)
	expect(env.HOME).toBe(process.env.HOME)
})
