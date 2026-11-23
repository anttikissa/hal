// Discovers Antigravity (`agy`) models, display names and reasoning-effort
// levels from `agy models` and ACP `session/new` responses, mapping Hal's
// /effort levels (low, medium, high, xhigh, max) onto agy variants and
// thought_level config options. Task xbp.

import { effortLevels, type EffortLevel } from '../common/effort-levels.ts'
import type { Capability } from './model-effort.ts'

export type ModelEntry = {
	name?: string
	levels: EffortLevel[]
	defaultLevel?: EffortLevel
	variants: Map<EffortLevel, string>
	bareId?: string
}

const state = {
	offered: [] as string[],
	catalog: new Map<string, ModelEntry>(),
	// Context windows reported by agy via usage_update.size, per base model.
	windows: new Map<string, number>(),
}

const effortSuffix = /^(.*)-(low|medium|high|xhigh|max)$/
const labelSuffix = /\s+\((?:Low|Medium|High|XHigh|Extra|Max)\)$/i
const effortOrder = (levels: EffortLevel[]): EffortLevel[] =>
	[...new Set(levels)].sort((a, b) => effortLevels.levels.indexOf(a) - effortLevels.levels.indexOf(b))

function record(items: { modelId: string; name?: string }[]): void {
	if (!items.length) return
	state.offered = items.map((m) => m.modelId)
	let map = new Map<string, ModelEntry>()
	for (let item of items) {
		let m = effortSuffix.exec(item.modelId)
		let base = m ? m[1]! : item.modelId
		let level = m ? (m[2] as EffortLevel) : undefined
		let entry = map.get(base)
		if (!entry) {
			entry = { levels: [], variants: new Map() }
			map.set(base, entry)
		}
		if (!entry.name && item.name) entry.name = item.name.replace(labelSuffix, '').trim()
		if (level) {
			if (!entry.defaultLevel) entry.defaultLevel = level
			entry.variants.set(level, item.modelId)
			if (!entry.levels.includes(level)) entry.levels.push(level)
		} else entry.bareId = item.modelId
	}
	for (let entry of map.values()) entry.levels = effortOrder(entry.levels)
	state.catalog = map
}

function known(): string[] {
	return state.catalog.size
		? [...state.catalog.keys()]
		: [
				'gemini-4-neon',
				'gemini-4-argon',
				'gemini-4-hydrogen',
				'gemini-3.8-flash',
				'claude-opus-5-5',
				'claude-sonnet-5-5',
				'gpt-oss-120b',
			]
}

async function fetch(command: string[], signal?: AbortSignal): Promise<string[]> {
	if (state.catalog.size) return [...state.catalog.keys()]
	let proc = Bun.spawn([...command, 'models'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
	let onAbort = () => {
		try {
			proc.kill()
		} catch {}
	}
	signal?.addEventListener('abort', onAbort, { once: true })
	try {
		let [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		])
		if (signal?.aborted) throw new Error('aborted')
		if (code !== 0) {
			let err = stderr.trim()
			throw new Error(`agy models exited with code ${code}${err ? `\nstderr:\n${err}` : ''}`)
		}
		let parsed: { modelId: string; name?: string }[] = []
		for (let line of stdout.split(/\r?\n/)) {
			let tab = line.indexOf('\t')
			if (tab > 0) {
				let id = line.slice(0, tab).trim()
				let name = line.slice(tab + 1).trim()
				if (id && !/\s/.test(id)) parsed.push({ modelId: id, name })
				continue
			}
			let m = /^([a-z0-9][a-z0-9._-]+)\s{2,}(.+)$/.exec(line.trim())
			if (m) parsed.push({ modelId: m[1]!, name: m[2]!.trim() })
		}
		if (!parsed.length) throw new Error('agy models returned no models')
		agyModels.record(parsed)
		return [...state.catalog.keys()]
	} finally {
		signal?.removeEventListener('abort', onAbort)
	}
}

function displayName(model: string): string | undefined {
	return state.catalog.get(model)?.name
}

function capability(model: string): Capability | undefined {
	let entry = state.catalog.get(model)
	if (entry) {
		if (!entry.levels.length) return undefined
		return { levels: entry.levels, default: entry.defaultLevel ?? entry.levels[0]!, wire: () => ({}) }
	}
	if (model.startsWith('gemini-pro-orchestrator')) return undefined
	let levels: EffortLevel[] = /neon|hydrogen/.test(model)
		? ['low', 'medium', 'high', 'xhigh', 'max']
		: model.startsWith('gpt-oss')
			? ['medium']
			: ['low', 'medium', 'high']
	return { levels, default: levels.includes('high') ? 'high' : levels[0]!, wire: () => ({}) }
}

function resolve(model: string, effort?: string): { modelId: string; level?: EffortLevel } {
	let entry = state.catalog.get(model)
	let level = (effort ?? entry?.defaultLevel) as EffortLevel | undefined
	let modelId =
		(level && entry?.variants.get(level)) ??
		(level && state.offered.includes(`${model}-${level}`) ? `${model}-${level}` : undefined) ??
		entry?.bareId ??
		(entry?.defaultLevel && entry.variants.get(entry.defaultLevel)) ??
		[`${model}-high`, `${model}-medium`].find((id) => state.offered.includes(id)) ??
		model
	return { modelId, level }
}

function contextWindow(model: string): number | undefined {
	return state.windows.get(model)
}

export const agyModels = { state, record, known, fetch, displayName, contextWindow, capability, resolve }
