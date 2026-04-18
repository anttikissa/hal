import { expect, test } from 'bun:test'
import { FLAKY_TEST_FILES, isolatedTestEnv, listTestFiles, parseArgs } from './test-parallel.ts'

test('isolatedTestEnv forces HAL_STATE_DIR for spawned test processes', () => {
	const env = isolatedTestEnv('/tmp/hal-test-state-demo')
	expect(env.HAL_STATE_DIR).toBe('/tmp/hal-test-state-demo')
	expect(env.PATH).toBe(process.env.PATH)
	expect(env.HOME).toBe(process.env.HOME)
})

test('parseArgs enables the flaky suite', () => {
	expect(parseArgs(['--flaky'])).toEqual({ flakyOnly: true, filter: undefined })
	expect(parseArgs(['--flaky', 'tail-file'])).toEqual({ flakyOnly: true, filter: 'tail-file' })
})

test('default suite excludes known flaky files', () => {
	const files = listTestFiles()
	for (const file of FLAKY_TEST_FILES) {
		expect(files).not.toContain(file)
	}
})

test('flaky suite contains only known flaky files', () => {
	const files = listTestFiles({ flakyOnly: true })
	expect(files.length).toBe(FLAKY_TEST_FILES.size)
	for (const file of files) {
		expect(FLAKY_TEST_FILES.has(file)).toBe(true)
	}
})
