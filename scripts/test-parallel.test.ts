import { expect, test } from 'bun:test'
import { FLAKY_TEST_FILES, isolatedTestEnv, listTestFiles, parseArgs } from './test-parallel.ts'

test('default suite excludes known flaky files', () => {
	const files = listTestFiles()
	for (const file of FLAKY_TEST_FILES) {
		expect(files).not.toContain(file)
	}
}, { timeout: 10_000 })
