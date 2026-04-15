// Color system — loads colors.ason, resolves OKLCH values to ANSI escapes,
// and live-reloads on file change.
//
// Modules import `colors` and access e.g. `colors.assistant.fg`.
// The objects are mutable — reload updates them in place.
// Importing this module stays cheap; file I/O and watchers live in init().

import { readFileSync } from 'fs'
import { liveFiles } from '../utils/live-file.ts'
import { ason } from '../utils/ason.ts'
import { oklch } from '../utils/oklch.ts'

const HAL_DIR = import.meta.dir.replace(/\/src\/cli$/, '')
const COLORS_PATH = `${HAL_DIR}/colors.ason`

// ── Public color objects — mutated in place by load() ────────────────────────

type BlockColors = { fg: string; bg: string }
type MdColors = BlockColors & { bold: string; code: string }

const assistant: MdColors = { fg: '', bg: '', bold: '', code: '' }
const thinking: MdColors = { fg: '', bg: '', bold: '', code: '' }
const user: BlockColors = { fg: '', bg: '' }
const input = { fg: '', bg: '', cursor: '' }
const system: BlockColors = { fg: '', bg: '' }
const info: BlockColors = { fg: '', bg: '' }
const warning: BlockColors = { fg: '', bg: '' }
const error: BlockColors = { fg: '', bg: '' }
const startup: BlockColors = { fg: '', bg: '' }
const fork: BlockColors = { fg: '', bg: '' }
const popup = { current: { fg: '', bg: '' } }

// Tool colors keyed by tool name. Unknown tools fall back to 'default'.
const tools: Record<string, BlockColors> = {}

const state = {
	initialized: false,
	watcher: null as object | null,
}

// ── OKLCH triple resolution ──────────────────────────────────────────────────
//
// A triple is [L, C, H] where L/C can be "$varName" references.

type Triple = [number | string, number | string, number | string]

function resolveTriple(t: Triple, vars: Record<string, number>): [number, number, number] {
	return t.map((v) => (typeof v === 'string' && v.startsWith('$') ? (vars[v.slice(1)] ?? 0) : Number(v))) as [
		number,
		number,
		number,
	]
}

function fg(t: Triple, vars: Record<string, number>): string {
	return oklch.toFg(...resolveTriple(t, vars))
}

function bg(t: Triple, vars: Record<string, number>): string {
	return oklch.toBg(...resolveTriple(t, vars))
}

// ── Load + resolve ───────────────────────────────────────────────────────────

function load(): void {
	let raw: any
	try {
		raw = ason.parse(readFileSync(COLORS_PATH, 'utf-8'))
	} catch (err: any) {
		throw new Error(`Fatal: failed to parse ${COLORS_PATH}: ${err?.message ?? String(err)}`)
	}
	if (!raw || typeof raw !== 'object') {
		throw new Error(`Fatal: ${COLORS_PATH} must contain an object`)
	}

	const vars: Record<string, number> = { ...raw.vars }

	// Helper: resolve a block definition { fg: [...], bg: [...] }
	function resolveBlock(def: any, target: BlockColors): void {
		if (def?.fg) target.fg = fg(def.fg, vars)
		if (def?.bg) target.bg = bg(def.bg, vars)
	}

	// Assistant + thinking have extra md colors (bold, code)
	function resolveMd(def: any, target: MdColors): void {
		resolveBlock(def, target)
		if (def?.bold) target.bold = fg(def.bold, vars)
		else target.bold = target.fg
		if (def?.code) target.code = fg(def.code, vars)
		else target.code = target.fg
	}

	resolveMd(raw.assistant, assistant)
	resolveMd(raw.thinking, thinking)
	resolveBlock(raw.user, user)
	resolveBlock(raw.system, system)
	resolveBlock(raw.error, error)
	resolveBlock(raw.popup?.current, popup.current)

	resolveBlock(raw.info, info)
	resolveBlock(raw.warning ?? raw.info, warning)
	resolveBlock(raw.startup ?? raw.warning ?? raw.info, startup)
	resolveBlock(raw.fork ?? raw.startup ?? raw.warning ?? raw.info, fork)

	if (raw.input) {
		if (raw.input.fg) input.fg = fg(raw.input.fg, vars)
		if (raw.input.bg) input.bg = bg(raw.input.bg, vars)
		if (raw.input.cursor) input.cursor = fg(raw.input.cursor, vars)
	}

	// Tools
	const toolDefs = raw.tools ?? {}
	for (const [name, def] of Object.entries(toolDefs)) {
		if (!tools[name]) tools[name] = { fg: '', bg: '' }
		resolveBlock(def, tools[name]!)
	}

	// Aliases — read-like tools share read's colors
	if (tools.read) {
		tools.grep = tools.read
		tools.glob = tools.read
		tools.ls = tools.read
	}
}

function init(): void {
	if (state.initialized) return
	state.initialized = true

	load()

	// liveFile watches the file; we just need the onChange callback to re-resolve.
	// Use a dummy liveFile (read-only, we never write back to colors.ason).
	state.watcher = liveFiles.liveFile(COLORS_PATH, {}, { watch: true })
	liveFiles.onChange(state.watcher, load)
}

// Get colors for a tool by name. Strips mcp__ prefix.
function tool(name: string): BlockColors {
	const stripped = name.startsWith('mcp__') ? name.replace(/^mcp__[^_]+__/, '') : name
	return tools[stripped] ?? tools.default ?? { fg: '', bg: '' }
}

export const colors = {
	state,
	assistant,
	thinking,
	user,
	input,
	system,
	info,
	warning,
	error,
	startup,
	fork,
	popup,
	tool,
	tools,
	load,
	init,
}
