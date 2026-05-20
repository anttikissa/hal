// Runtime configuration — loads config.ason and applies overrides to module
// config objects. Importing this module must stay cheap: no file I/O, no
// watcher setup, no render invalidation. That all lives behind init().

import { ason } from './utils/ason.ts'
import { liveFiles } from './utils/live-file.ts'
import { client } from './client.ts'
import { blocks } from './cli/blocks.ts'
import { prompt } from './cli/prompt.ts'
import { clipboard } from './cli/clipboard.ts'
import { render } from './client/render.ts'
import { renderStatus } from './client/render-status.ts'
import { agentLoop } from './runtime/agent-loop.ts'
import { memory } from './memory.ts'
import { models } from './models.ts'
import { anthropicUsage } from './anthropic-usage.ts'
import { openaiUsage } from './openai-usage.ts'
import { openai } from './providers/openai.ts'
import { subscriptionUsage } from './subscription-usage.ts'
import { toolRegistry } from './tools/tool.ts'
import { log } from './utils/log.ts'

// Module name → config object. Add new modules here as they gain configs.
const modules: Record<string, Record<string, any>> = {
	client: client.config,
	blocks: blocks.config,
	prompt: prompt.config,
	clipboard: clipboard.config,
	render: render.config,
	renderStatus: renderStatus.config,
	agentLoop: agentLoop.config,
	memory: memory.config,
	models: models.config,
	subscriptionUsage: subscriptionUsage.config,
	anthropicUsage: anthropicUsage.config,
	openaiUsage: openaiUsage.config,
	openai: openai.config,
	toolRegistry: toolRegistry.config,
	log: log.config,
}

// config.ason lives at repo root — it's user-facing config.
const HAL_DIR = import.meta.dir.replace(/\/src$/, '')
const CONFIG_PATH = `${HAL_DIR}/config.ason`

const state = {
	initialized: false,
}

function splitPath(path: string): string[] {
	return path.split('.').filter(Boolean)
}

function snapshot(): Record<string, any> {
	const out: Record<string, any> = {}
	for (const [name, moduleConfig] of Object.entries(config.modules)) out[name] = moduleConfig
	return out
}

function readValue(root: any, parts: string[]): any {
	let value = root
	for (const part of parts) {
		if (!value || typeof value !== 'object' || !(part in value)) return undefined
		value = value[part]
	}
	return value
}

function readPath(path: string): { value?: any; error?: string } {
	const parts = splitPath(path)
	if (parts.length === 0) return { error: 'Usage: /config [module[.key]] [value] [--temp]' }
	const root = config.modules[parts[0]!]
	if (!root) return { error: `Unknown config module: ${parts[0]}` }
	const value = readValue(root, parts.slice(1))
	return parts.length === 1 || value !== undefined ? { value: parts.length === 1 ? root : value } : { error: `Unknown config key: ${path}` }
}

function canUseBareStringValue(raw: string): boolean {
	const trimmed = raw.trim()
	return !!trimmed && !/\s/.test(trimmed) && !/^["'`\[{]/.test(trimmed)
}

function parseValue(path: string, raw: string): any {
	try {
		return ason.parse(raw)
	} catch (err) {
		if (typeof readPath(path).value === 'string' && canUseBareStringValue(raw)) return raw.trim()
		throw err
	}
}

function hasPath(root: any, parts: string[]): boolean {
	let value = root
	for (const part of parts) {
		if (!value || typeof value !== 'object' || !(part in value)) return false
		value = value[part]
	}
	return true
}

function ensureObject(root: Record<string, any>, parts: string[]): Record<string, any> | null {
	let node = root
	for (const part of parts) {
		const next = node[part]
		if (next == null) node = node[part] = {}
		else if (!next || typeof next !== 'object' || Array.isArray(next)) return null
		else node = next
	}
	return node
}

function writePath(path: string, value: any, opts: { temp?: boolean } = {}): { output?: string; error?: string } {
	const parts = splitPath(path)
	if (parts.length < 2) return { error: 'Set a specific key like agentLoop.maxIterations.' }
	const moduleName = parts[0]!
	const keyParts = parts.slice(1)
	const leaf = parts[parts.length - 1]!
	const parentParts = parts.slice(1, -1)
	const moduleConfig = config.modules[moduleName]
	if (!moduleConfig) return { error: `Unknown config module: ${moduleName}` }
	if (!hasPath(moduleConfig, keyParts)) return { error: `Unknown config key: ${path}` }
	const root = opts.temp ? moduleConfig : config.data[moduleName]
	if (!opts.temp && (!root || typeof root !== 'object' || Array.isArray(root))) config.data[moduleName] = {}
	const parent = ensureObject((opts.temp ? moduleConfig : config.data[moduleName]) as Record<string, any>, parentParts)
	if (!parent) return { error: `${opts.temp ? 'Cannot write temp config' : 'Cannot write config'} at ${path}` }
	parent[leaf] = value
	if (!opts.temp) {
		config.apply()
		config.save()
	}
	return { output: `${opts.temp ? 'Temporarily set' : 'Set'} ${path} = ${ason.stringify(value, 'short')}` }
}

function listPaths(): string[] {
	const out: string[] = []
	function visit(prefix: string, value: unknown): void {
		out.push(prefix)
		if (!value || typeof value !== 'object' || Array.isArray(value)) return
		for (const key of Object.keys(value as Record<string, any>).sort()) visit(`${prefix}.${key}`, (value as Record<string, any>)[key])
	}
	for (const name of Object.keys(config.modules).sort()) visit(name, config.modules[name])
	return out
}

type ConfigReloadDiff = {
	path: string
	kind: 'added' | 'removed' | 'changed'
	previous?: any
	next?: any
}

function isPlainObject(value: any): value is Record<string, any> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function formatValue(value: any): string {
	return ason.stringify(value, 'short')
}

function sameValue(a: any, b: any): boolean {
	return formatValue(a) === formatValue(b)
}

function diffConfigObjects(previous: Record<string, any>, next: Record<string, any>, prefix = ''): ConfigReloadDiff[] {
	const out: ConfigReloadDiff[] = []
	const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
	for (const key of [...keys].sort()) {
		const path = prefix ? `${prefix}.${key}` : key
		const hadPrevious = Object.prototype.hasOwnProperty.call(previous, key)
		const hasNext = Object.prototype.hasOwnProperty.call(next, key)
		if (!hadPrevious) {
			out.push({ path, kind: 'added', next: next[key] })
			continue
		}
		if (!hasNext) {
			out.push({ path, kind: 'removed', previous: previous[key] })
			continue
		}
		const previousValue = previous[key]
		const nextValue = next[key]
		if (isPlainObject(previousValue) && isPlainObject(nextValue)) {
			out.push(...diffConfigObjects(previousValue, nextValue, path))
			continue
		}
		if (!sameValue(previousValue, nextValue)) out.push({ path, kind: 'changed', previous: previousValue, next: nextValue })
	}
	return out
}

function formatConfigReloadDiff(diff: ConfigReloadDiff): string {
	if (diff.kind === 'added') return `${diff.path} added: ${formatValue(diff.next)}`
	if (diff.kind === 'removed') return `${diff.path} removed: ${formatValue(diff.previous)}`
	return `${diff.path}: ${formatValue(diff.previous)} → ${formatValue(diff.next)}`
}

function formatReloadMessage(previous: Record<string, any>, next: Record<string, any>): string {
	const diffs = diffConfigObjects(previous, next)
	if (diffs.length === 0) return ''
	const limit = 8
	const shown = diffs.slice(0, limit)
	const parts: string[] = []
	for (const diff of shown) parts.push(formatConfigReloadDiff(diff))
	const more = diffs.length > shown.length ? ` (+${diffs.length - shown.length} more)` : ''
	return `config.ason reloaded: ${parts.join('; ')}${more}`
}

function apply(): void {
	for (const [name, overrides] of Object.entries(config.data)) {
		const target = config.modules[name]
		if (target && overrides && typeof overrides === 'object') Object.assign(target, overrides)
	}
}

function init(): void {
	if (state.initialized) return
	state.initialized = true

	// liveFile() does the real disk load and starts the watcher. Keeping that here
	// makes importing config.ts side-effect free.
	config.data = liveFiles.liveFile(CONFIG_PATH, {}) as Record<string, any>
	config.apply()
	liveFiles.onChange(config.data, (change: { previous: Record<string, any>; next: Record<string, any> }) => {
		const message = config.formatReloadMessage(change.previous, change.next)
		config.apply()
		render.invalidateHistoryCache()
		if (message) client.addEntry(message)
		else client.requestRender(false)
	})
}

function save(): void {
	// Saving before init would write a plain empty object instead of the watched
	// live-file proxy. Explicit calls may initialize; imports may not.
	if (!config.state.initialized) config.init()
	liveFiles.save(config.data)
}

export const config = {
	state,
	modules,
	data: {} as Record<string, any>,
	init,
	apply,
	save,
	snapshot,
	listPaths,
	readPath,
	parseValue,
	writePath,
	formatReloadMessage,
}
