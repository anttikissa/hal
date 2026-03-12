import { readFile as fsReadFile } from 'fs/promises'
import { readFileSync as fsReadFileSync } from 'fs'

export type AsyncReadMethod = 'bun-file' | 'fs-readFile'

export interface FileReadSample {
	path: string
	source: string
	mode: 'text' | 'bytes'
	sync: boolean
	method: 'bun-file' | 'fs-readFile' | 'fs-readFileSync'
	startedAtMs: number
	endedAtMs: number
	elapsedMs: number
	bytes: number
}

export const readFileConfig = {
	enabled: true,
	maxSamples: 10_000,
	asyncTextMethod: 'bun-file' as AsyncReadMethod,
}

const samples: FileReadSample[] = []
let droppedSamples = 0

function record(sample: FileReadSample): void {
	if (!readFileConfig.enabled) return
	if (samples.length >= readFileConfig.maxSamples) {
		samples.shift()
		droppedSamples += 1
	}
	samples.push(sample)
}

function nowMs(): number {
	return Date.now()
}

function elapsedMs(startedAtPerf: number): number {
	return Number((performance.now() - startedAtPerf).toFixed(3))
}

function sourceName(source?: string): string {
	return source ?? ''
}

export async function readText(path: string, source?: string): Promise<string> {
	const startedAtMs = nowMs()
	const startedAtPerf = performance.now()
	if (readFileConfig.asyncTextMethod === 'fs-readFile') {
		const text = await fsReadFile(path, 'utf-8')
		record({
			path,
			source: sourceName(source),
			mode: 'text',
			sync: false,
			method: 'fs-readFile',
			startedAtMs,
			endedAtMs: nowMs(),
			elapsedMs: elapsedMs(startedAtPerf),
			bytes: Buffer.byteLength(text),
		})
		return text
	}
	const file = Bun.file(path)
	const text = await file.text()
	const size = typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0
		? Math.floor(file.size)
		: Buffer.byteLength(text)
	record({
		path,
		source: sourceName(source),
		mode: 'text',
		sync: false,
		method: 'bun-file',
		startedAtMs,
		endedAtMs: nowMs(),
		elapsedMs: elapsedMs(startedAtPerf),
		bytes: size,
	})
	return text
}

export function readTextSync(path: string, source?: string): string {
	const startedAtMs = nowMs()
	const startedAtPerf = performance.now()
	const text = fsReadFileSync(path, 'utf-8')
	record({
		path,
		source: sourceName(source),
		mode: 'text',
		sync: true,
		method: 'fs-readFileSync',
		startedAtMs,
		endedAtMs: nowMs(),
		elapsedMs: elapsedMs(startedAtPerf),
		bytes: Buffer.byteLength(text),
	})
	return text
}

export function readBytesSync(path: string, source?: string): Buffer {
	const startedAtMs = nowMs()
	const startedAtPerf = performance.now()
	const data = fsReadFileSync(path)
	record({
		path,
		source: sourceName(source),
		mode: 'bytes',
		sync: true,
		method: 'fs-readFileSync',
		startedAtMs,
		endedAtMs: nowMs(),
		elapsedMs: elapsedMs(startedAtPerf),
		bytes: data.byteLength,
	})
	return data
}

export function clearSamples(): void {
	samples.length = 0
	droppedSamples = 0
}

export function getSamples(): { samples: FileReadSample[]; dropped: number } {
	return { samples: samples.slice(), dropped: droppedSamples }
}

export const readFiles = {
	readText,
	readTextSync,
	readBytesSync,
	clearSamples,
	getSamples,
	config: readFileConfig,
}
