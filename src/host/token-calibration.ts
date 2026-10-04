// Real successful rounds teach a per-model ratio; images do not teach a
// character ratio because their input tokens are not proportional to bytes.
import { mkdirSync } from 'fs'
import { tokenEstimates } from '../common/token-estimates.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

function store(): Record<string, number> {
	let path = `${paths.stateDir()}/calibration.ason`
	let data = liveFiles.liveFile<Record<string, number>>(path, {}, { watch: false })
	for (let [model, ratio] of Object.entries(data)) if (!Number.isFinite(ratio) || ratio <= 0) {
		liveFiles.close(data)
		throw new Error(`${path}: invalid characters-per-token ratio for ${JSON.stringify(model)}: ${JSON.stringify(ratio)}`)
	}
	return data
}

function ratios(): Record<string, number> {
	let data = tokenCalibration.store()
	try { return { ...data } } finally { liveFiles.close(data) }
}

function observe(model: string, characters: number, tokens: number): void {
	if (!Number.isFinite(characters) || !Number.isFinite(tokens) || characters <= 0 || tokens <= 0) return
	mkdirSync(paths.stateDir(), { recursive: true, mode: 0o700 })
	let data = tokenCalibration.store()
	try {
		let sample = characters / tokens
		let previous = Object.hasOwn(data, model) ? data[model] : undefined
		// Bound an outlier before smoothing: one odd round changes an
		// established estimate by at most 2.5%, not by an arbitrary amount.
		data[model] = previous === undefined ? sample : previous + tokenCalibration.weight * (Math.max(previous * .75, Math.min(previous * 1.25, sample)) - previous)
		liveFiles.save(data)
	} finally { liveFiles.close(data) }
}

function estimateTokens(characters: number, model?: string): number {
	return tokenEstimates.estimate(characters, model, model ? tokenCalibration.ratios() : {})
}

export const tokenCalibration = { store, ratios, observe, estimateTokens, weight: .1 }
