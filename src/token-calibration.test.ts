import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { tokenCalibration } from './token-calibration.ts'
import { ason } from './utils/ason.ts'

const origStateDir = process.env.HAL_STATE_DIR
let tempStateDir: string | null = null

function useTempStateDir(): string {
	tempStateDir = mkdtempSync(join(tmpdir(), 'hal-token-calibration-'))
	process.env.HAL_STATE_DIR = tempStateDir
	return tempStateDir
}

afterEach(() => {
	if (origStateDir === undefined) delete process.env.HAL_STATE_DIR
	else process.env.HAL_STATE_DIR = origStateDir
	if (tempStateDir) rmSync(tempStateDir, { recursive: true, force: true })
	tempStateDir = null
})

test('save stores per-model bytes-per-token calibration in state/calibration.ason', () => {
	const stateDir = useTempStateDir()

	tokenCalibration.save(1200, 300, 'openai/gpt-test')

	const saved = ason.parse(readFileSync(`${stateDir}/calibration.ason`, 'utf-8')) as any
	expect(saved['openai/gpt-test']).toMatchObject({
		systemBytes: 1200,
		systemTokens: 300,
		bytesPerToken: 4,
	})
	expect(typeof saved['openai/gpt-test'].calibratedAt).toBe('string')
})

test('estimateTokens uses model calibration and falls back to four bytes per token', () => {
	useTempStateDir()

	tokenCalibration.save(1500, 500, 'anthropic/claude-test')

	expect(tokenCalibration.estimateTokens(900, 'anthropic/claude-test')).toBe(300)
	expect(tokenCalibration.estimateTokens(900, 'openai/uncalibrated')).toBe(225)
})
