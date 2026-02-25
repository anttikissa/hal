import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { stdin, stdout } from 'node:process'
import { parse, stringify } from '../src/utils/ason.ts'
import { parseKeys } from '../src/cli/tui-text.ts'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const ESC = '\x1b'
const KITTY_DISABLE = '\x1b[<u'

type CapturePreset = 'smoke' | 'tui' | 'full'
type CaptureStatus = 'captured' | 'empty' | 'timeout'

type CaptureStep = {
	id: string
	label: string
	category: string
	note?: string
	timeoutMs?: number
	escTwice?: boolean
}

type CaptureProfile = {
	id: string
	label: string
	enable?: string
	disable?: string
}

type CaptureToken = {
	text: string
	display: string
	hex: string
	kind: string
}

type StepCapture = {
	stepId: string
	label: string
	category: string
	status: CaptureStatus
	note?: string
	timeoutMs: number
	durationMs: number
	delimiterHex: string
	bytes: number[]
	hex: string
	text: string
	display: string
	tokens: CaptureToken[]
	tokenKinds: string[]
}

type CalibrationCapture = {
	status: 'captured' | 'timeout'
	durationMs: number
	idleMs: number
	bytes: number[]
	hex: string
	text: string
	display: string
}

type ProfileRun = {
	id: string
	label: string
	enable?: string
	disable?: string
	calibration: CalibrationCapture
	steps: StepCapture[]
}

type CliOptions = {
	terminalLabel?: string
	outPath?: string
	preset: CapturePreset
	profiles: string[]
	step?: string
	stepTimeoutMs: number
	calibrationTimeoutMs: number
	idleMs: number
	listSteps: boolean
	help: boolean
}

const PROFILE_DEFS: Record<string, CaptureProfile> = {
	raw: {
		id: 'raw',
		label: 'Raw (no keyboard protocol)',
	},
	hal11: {
		id: 'hal11',
		label: 'HAL Kitty keyboard mode (>11u)',
		enable: '\x1b[>11u',
		disable: KITTY_DISABLE,
	},
	kitty31: {
		id: 'kitty31',
		label: 'Kitty keyboard mode (>31u)',
		enable: '\x1b[>31u',
		disable: KITTY_DISABLE,
	},
}

function step(
	id: string,
	label: string,
	category: string,
	opts: Partial<Pick<CaptureStep, 'note' | 'timeoutMs' | 'escTwice'>> = {},
): CaptureStep {
	return { id, label, category, ...opts }
}

function rangeSteps(
	prefix: string,
	labelPrefix: string,
	category: string,
	start: number,
	end: number,
): CaptureStep[] {
	const out: CaptureStep[] = []
	for (let i = start; i <= end; i++) out.push(step(`${prefix}_${i}`, `${labelPrefix}${i}`, category))
	return out
}

const SMOKE_STEPS: CaptureStep[] = [
	step('esc', 'Esc', 'basic', { escTwice: true, note: 'Press Esc twice: first is target, second ends step.' }),
	step('a', 'a', 'basic'),
	step('A', 'Shift-A', 'basic'),
	step('enter', 'Enter', 'editing'),
	step('tab', 'Tab', 'editing'),
	step('backspace', 'Backspace', 'editing'),
	step('left', 'Left Arrow', 'nav'),
	step('right', 'Right Arrow', 'nav'),
	step('up', 'Up Arrow', 'nav'),
	step('down', 'Down Arrow', 'nav'),
	step('ctrl_w', 'Ctrl-W', 'ctrl'),
	step('cmd_x', 'Cmd-X', 'cmd', { note: 'macOS: terminal/OS may intercept; empty capture is useful data.' }),
]

const TUI_STEPS: CaptureStep[] = [
	step('esc', 'Esc', 'basic', { escTwice: true, note: 'Press Esc twice: first is target, second ends step.' }),
	step('shift_esc', 'Shift-Esc', 'basic', {
		escTwice: true,
		note: 'Often same bytes as Esc; press Shift-Esc, then Esc again to end.',
	}),
	step('a', 'a', 'basic'),
	step('A', 'Shift-A', 'basic'),
	step('space', 'Space', 'basic'),
	step('enter', 'Enter', 'editing'),
	step('shift_enter', 'Shift-Enter', 'editing'),
	step('alt_enter', 'Option/Alt-Enter', 'editing'),
	step('tab', 'Tab', 'editing'),
	step('shift_tab', 'Shift-Tab', 'editing'),
	step('backspace', 'Backspace', 'editing'),
	step('delete', 'Delete (Forward Delete)', 'editing', {
		note: 'On macOS laptop keyboards this is usually Fn-Delete.',
	}),
	step('left', 'Left Arrow', 'nav'),
	step('right', 'Right Arrow', 'nav'),
	step('up', 'Up Arrow', 'nav'),
	step('down', 'Down Arrow', 'nav'),
	step('shift_left', 'Shift-Left Arrow', 'nav'),
	step('shift_right', 'Shift-Right Arrow', 'nav'),
	step('shift_up', 'Shift-Up Arrow', 'nav'),
	step('shift_down', 'Shift-Down Arrow', 'nav'),
	step('alt_left', 'Option/Alt-Left Arrow', 'nav'),
	step('alt_right', 'Option/Alt-Right Arrow', 'nav'),
	step('ctrl_a', 'Ctrl-A', 'ctrl'),
	step('ctrl_c', 'Ctrl-C', 'ctrl'),
	step('ctrl_d', 'Ctrl-D', 'ctrl'),
	step('ctrl_e', 'Ctrl-E', 'ctrl'),
	step('ctrl_f', 'Ctrl-F', 'ctrl'),
	step('ctrl_k', 'Ctrl-K', 'ctrl'),
	step('ctrl_n', 'Ctrl-N', 'ctrl'),
	step('ctrl_p', 'Ctrl-P', 'ctrl'),
	step('ctrl_t', 'Ctrl-T', 'ctrl'),
	step('ctrl_u', 'Ctrl-U', 'ctrl'),
	step('ctrl_v', 'Ctrl-V', 'ctrl'),
	step('ctrl_w', 'Ctrl-W', 'ctrl'),
	step('ctrl_x', 'Ctrl-X', 'ctrl'),
	step('ctrl_y', 'Ctrl-Y', 'ctrl'),
	step('ctrl_z', 'Ctrl-Z', 'ctrl'),
	step('alt_1', 'Option/Alt-1', 'alt'),
	step('cmd_a', 'Cmd-A', 'cmd', { note: 'macOS: may be intercepted or sent only in Kitty mode.' }),
	step('cmd_v', 'Cmd-V', 'cmd', {
		note: 'macOS: may paste clipboard content instead of sending key. Empty or pasted text are both useful.',
		timeoutMs: 15_000,
	}),
	step('cmd_x', 'Cmd-X', 'cmd', { note: 'macOS: terminal/OS may intercept cut.' }),
	step('cmd_z', 'Cmd-Z', 'cmd', { note: 'macOS: terminal/OS may intercept undo.' }),
]

const FULL_STEPS: CaptureStep[] = [
	...TUI_STEPS,
	...rangeSteps('alt', 'Option/Alt-', 'alt', 4, 9),
	...rangeSteps('ctrl', 'Ctrl-', 'ctrl', 4, 9),
	step('home', 'Home', 'nav'),
	step('end', 'End', 'nav'),
	step('page_up', 'Page Up', 'nav'),
	step('page_down', 'Page Down', 'nav'),
	step('alt_up', 'Option/Alt-Up Arrow', 'nav'),
	step('alt_down', 'Option/Alt-Down Arrow', 'nav'),
	step('cmd_up', 'Cmd-Up Arrow', 'cmd'),
	step('cmd_down', 'Cmd-Down Arrow', 'cmd'),
	step('cmd_shift_up', 'Cmd-Shift-Up Arrow', 'cmd'),
	step('cmd_shift_down', 'Cmd-Shift-Down Arrow', 'cmd'),
	step('cmd_backspace', 'Cmd-Backspace', 'cmd'),
	step('ctrl_left', 'Ctrl-Left Arrow', 'ctrl'),
	step('ctrl_right', 'Ctrl-Right Arrow', 'ctrl'),
	step('ctrl_shift_left', 'Ctrl-Shift-Left Arrow', 'ctrl'),
	step('ctrl_shift_right', 'Ctrl-Shift-Right Arrow', 'ctrl'),
]

const PRESET_STEPS: Record<CapturePreset, CaptureStep[]> = {
	smoke: SMOKE_STEPS,
	tui: TUI_STEPS,
	full: FULL_STEPS,
}

class RawInputQueue {
	private queue: Buffer[] = []
	private waiter: ((chunk: Buffer | null) => void) | null = null
	private waiterTimer: ReturnType<typeof setTimeout> | null = null

	onData = (chunk: Buffer | string) => {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		if (this.waiter) {
			const resolve = this.waiter
			this.waiter = null
			if (this.waiterTimer) {
				clearTimeout(this.waiterTimer)
				this.waiterTimer = null
			}
			resolve(buf)
			return
		}
		this.queue.push(buf)
	}

	start(): void {
		stdin.on('data', this.onData)
	}

	stop(): void {
		stdin.off('data', this.onData)
		if (this.waiterTimer) {
			clearTimeout(this.waiterTimer)
			this.waiterTimer = null
		}
		if (this.waiter) {
			const resolve = this.waiter
			this.waiter = null
			resolve(null)
		}
	}

	clear(): void {
		this.queue = []
	}

	async nextChunk(timeoutMs: number): Promise<Buffer | null> {
		if (this.queue.length > 0) return this.queue.shift() ?? null
		if (timeoutMs <= 0) return null
		return await new Promise<Buffer | null>((resolve) => {
			this.waiter = resolve
			this.waiterTimer = setTimeout(() => {
				if (this.waiter === resolve) this.waiter = null
				this.waiterTimer = null
				resolve(null)
			}, timeoutMs)
		})
	}
}

function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		preset: 'tui',
		profiles: ['hal11'],
		stepTimeoutMs: 8_000,
		calibrationTimeoutMs: 15_000,
		idleMs: 600,
		listSteps: false,
		help: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const next = () => argv[++i]
			if (arg === '--help' || arg === '-h') opts.help = true
			else if (arg === '--list-steps') opts.listSteps = true
			else if (arg === '--terminal') opts.terminalLabel = next()
			else if (arg === '--out') opts.outPath = next()
			else if (arg === '--step') opts.step = next()
			else if (arg === '--preset') {
				const v = next() as CapturePreset
				if (!PRESET_STEPS[v]) throw new Error(`Unknown preset: ${v}`)
			opts.preset = v
		} else if (arg === '--profiles') {
			const raw = (next() || '').split(',').map((s) => s.trim()).filter(Boolean)
			if (raw.length === 0) throw new Error('--profiles requires at least one profile id')
			for (const id of raw) {
				if (!PROFILE_DEFS[id]) throw new Error(`Unknown profile: ${id}`)
			}
			opts.profiles = raw
		} else if (arg === '--step-timeout-ms') {
			const v = Number(next())
			if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --step-timeout-ms')
			opts.stepTimeoutMs = Math.round(v)
		} else if (arg === '--calibration-timeout-ms') {
			const v = Number(next())
			if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --calibration-timeout-ms')
			opts.calibrationTimeoutMs = Math.round(v)
		} else if (arg === '--idle-ms') {
			const v = Number(next())
			if (!Number.isFinite(v) || v <= 0) throw new Error('Invalid --idle-ms')
			opts.idleMs = Math.round(v)
		} else {
			throw new Error(`Unknown arg: ${arg}`)
		}
	}
	return opts
}

function printHelp(): void {
	stdout.write(`Usage: bun scripts/capture.ts [options]

Interactive terminal key capture for TUI keyboard fixtures.

Options:
	--preset <smoke|tui|full>         Step preset (default: tui)
	--profiles <ids>                  Comma list: raw,hal11,kitty31 (default: hal11)
	--step <n|id>                     Capture only one step by 1-based index or step id and rewrite it in output file
	--terminal <label>                Terminal label for output filename (default: TERM_PROGRAM or TERM)
	--out <path>                      Output ASON path (default: src/tests/fixtures/keys/keys-<terminal>.ason)
	--step-timeout-ms <n>             Per-step timeout waiting for delimiter Esc (default: 8000)
	--calibration-timeout-ms <n>      Timeout waiting for Esc calibration (default: 15000)
	--idle-ms <n>                     Idle gap used to end calibration gesture (default: 600)
	--list-steps                      Print step list for selected preset and exit
	-h, --help                        Show help

Per step:
	Press the requested key/combo, then press Esc to end the step.
	If the target is Esc (or Shift-Esc), press it first, then press Esc again as the delimiter.
	Pressing only the delimiter records an empty capture (useful for OS/terminal-intercepted shortcuts).
`)
}

function listSteps(preset: CapturePreset): void {
	const steps = PRESET_STEPS[preset]
	stdout.write(`Preset: ${preset} (${steps.length} steps)\n\n`)
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i]
		const note = s.note ? ` [${s.note}]` : ''
		stdout.write(`${String(i + 1).padStart(2, ' ')}. ${s.id} :: ${s.label} (${s.category})${note}\n`)
	}
}

function stepDescriptors(steps: CaptureStep[]) {
	return steps.map((s) => ({
		id: s.id,
		label: s.label,
		category: s.category,
		note: s.note,
		timeoutMs: s.timeoutMs,
		escTwice: !!s.escTwice,
	}))
}

function resolveSelectedStep(allSteps: CaptureStep[], selector: string): { step: CaptureStep; index: number } {
	const trimmed = selector.trim()
	if (/^\d+$/.test(trimmed)) {
		const index = Number(trimmed) - 1
		if (index < 0 || index >= allSteps.length)
			throw new Error(`--step index out of range: ${trimmed} (1..${allSteps.length})`)
		return { step: allSteps[index], index }
	}
	const index = allSteps.findIndex((s) => s.id === trimmed)
	if (index < 0) throw new Error(`--step id not found: ${trimmed}`)
	return { step: allSteps[index], index }
}

function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		|| 'terminal'
}

function defaultTerminalLabel(): string {
	return process.env.TERM_PROGRAM || process.env.TERM || process.platform
}

function defaultOutPath(terminalLabel: string): string {
	return resolve('src/tests/fixtures/keys', `keys-${slug(terminalLabel)}.ason`)
}

function bytesToHex(buf: Buffer): string {
	return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ')
}

function showText(text: string): string {
	let out = ''
	for (const ch of text) {
		const code = ch.charCodeAt(0)
		if (ch === '\x1b') out += 'ESC'
		else if (ch === '\r') out += '\\r'
		else if (ch === '\n') out += '\\n'
		else if (ch === '\t') out += '\\t'
		else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
		else out += ch
	}
	return out
}

function escapeAsonString(s: string): string {
	return showText(s)
}

function classifyToken(token: string): string {
	if (token === '\x1b') return 'esc'
	if (token.startsWith(PASTE_START) || token.startsWith(PASTE_END)) return 'paste-marker'
	if (/^\x1b\[\d*(;\d*(?::\d+)?)?u$/.test(token)) return 'kitty-csi-u'
	if (/^\x1b\[\d+;.*~$/.test(token)) return 'csi-tilde'
	if (/^\x1b\[[0-9;:<>]*[A-Za-z~]$/.test(token)) {
		if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(token)) return 'mouse'
		return 'csi'
	}
	if (/^\x1bO./.test(token)) return 'ss3'
	if (token.startsWith('\x1b]')) return 'osc'
	if (token.startsWith('\x1b')) return 'escape'
	if (token.length === 1 && token.charCodeAt(0) < 0x20) return 'control'
	if (token.length === 1) return 'char'
	if (token.includes('\n')) return 'multiline'
	return 'text'
}

function tokenizeCapture(text: string): CaptureToken[] {
	const tokens = parseKeys(text, PASTE_START, PASTE_END)
	return tokens.map((t) => ({
		text: showText(t),
		display: showText(t),
		hex: bytesToHex(Buffer.from(t)),
		kind: classifyToken(t),
	}))
}

async function drainInput(queue: RawInputQueue, idleMs = 80, maxDrains = 20): Promise<void> {
	for (let i = 0; i < maxDrains; i++) {
		const chunk = await queue.nextChunk(idleMs)
		if (!chunk) return
	}
}

function directWrite(text: string): void {
	stdout.write(text)
}

function line(text = ''): void {
	stdout.write(text + '\n')
}

async function captureGestureUntilIdle(
	queue: RawInputQueue,
	startTimeoutMs: number,
	idleMs: number,
	maxTotalMs: number,
): Promise<{ raw: Buffer | null; durationMs: number }> {
	const startedAt = Date.now()
	const first = await queue.nextChunk(startTimeoutMs)
	if (!first) return { raw: null, durationMs: Date.now() - startedAt }
	const parts: Buffer[] = [first]
	while (Date.now() - startedAt < maxTotalMs) {
		const next = await queue.nextChunk(idleMs)
		if (!next) break
		parts.push(next)
	}
	return { raw: Buffer.concat(parts), durationMs: Date.now() - startedAt }
}

async function captureStepUntilDelimiter(
	queue: RawInputQueue,
	delimiter: Buffer,
	timeoutMs: number,
	opts: { endDelimiterCount?: number } = {},
): Promise<{ status: CaptureStatus; payload: Buffer; durationMs: number }> {
	const endDelimiterCount = Math.max(1, opts.endDelimiterCount ?? 1)
	const startedAt = Date.now()
	const parts: Buffer[] = []
	let total = Buffer.alloc(0)
	while (Date.now() - startedAt < timeoutMs) {
		const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
		const chunk = await queue.nextChunk(remaining)
		if (!chunk) {
			return { status: 'timeout', payload: total, durationMs: Date.now() - startedAt }
		}
		parts.push(chunk)
		total = Buffer.concat(parts)
		let occ = 0
		let searchFrom = 0
		let endDelimStart = -1
		while (true) {
			const idx = total.indexOf(delimiter, searchFrom)
			if (idx < 0) break
			occ++
			if (occ === endDelimiterCount) {
				endDelimStart = idx
				break
			}
			searchFrom = idx + delimiter.length
		}
		if (endDelimStart >= 0) {
			const payload = total.subarray(0, endDelimStart)
			return {
				status: payload.length === 0 ? 'empty' : 'captured',
				payload,
				durationMs: Date.now() - startedAt,
			}
		}
	}
	return { status: 'timeout', payload: total, durationMs: Date.now() - startedAt }
}

function summarizeBytes(buf: Buffer) {
	const rawText = buf.toString('utf8')
	const text = showText(rawText)
	const tokens = tokenizeCapture(rawText)
	return {
		bytes: [...buf],
		hex: bytesToHex(buf),
		text,
		display: text,
		tokens,
		tokenKinds: [...new Set(tokens.map((t) => t.kind))],
	}
}

async function runCalibration(
	queue: RawInputQueue,
	profile: CaptureProfile,
	opts: CliOptions,
): Promise<{ delimiter: Buffer | null; calibration: CalibrationCapture }> {
	line()
	line(`== Profile: ${profile.label} (${profile.id}) ==`)
	line('Calibration: press Esc once and wait until the script continues (no need to press Enter).')
	line('This records the terminal-specific Esc event shape for this profile.')
	await drainInput(queue)
	const { raw, durationMs } = await captureGestureUntilIdle(
		queue,
		opts.calibrationTimeoutMs,
		opts.idleMs,
		opts.calibrationTimeoutMs,
	)
	if (!raw || raw.length === 0) {
		line('[calibration] timeout (no bytes captured)')
		return {
			delimiter: null,
			calibration: {
				status: 'timeout',
				durationMs,
				idleMs: opts.idleMs,
				bytes: [],
				hex: '',
				text: '',
				display: '',
			},
		}
	}
	const sum = summarizeBytes(raw)
	line(`[calibration] Esc delimiter = [${sum.hex}] ${sum.display}`)
	return {
		delimiter: raw,
		calibration: {
			status: 'captured',
			durationMs,
			idleMs: opts.idleMs,
			bytes: sum.bytes,
			hex: sum.hex,
			text: sum.text,
			display: sum.display,
		},
	}
}

function profileById(id: string): CaptureProfile {
	const p = PROFILE_DEFS[id]
	if (!p) throw new Error(`Unknown profile: ${id}`)
	return p
}

async function applyProfile(profile: CaptureProfile): Promise<void> {
	if (profile.enable) directWrite(profile.enable)
	await Bun.sleep(25)
}

async function clearProfile(profile: CaptureProfile): Promise<void> {
	if (profile.disable) directWrite(profile.disable)
	await Bun.sleep(25)
}

function printStepPrompt(index: number, total: number, stepDef: CaptureStep): void {
	line()
	line(`[${index + 1}/${total}] ${stepDef.label} (${stepDef.id})`)
	line(`Category: ${stepDef.category}`)
	if (stepDef.note) line(`Note: ${stepDef.note}`)
	line('Action: press the target key/combo, then press Esc as delimiter to end this step.')
	if (stepDef.escTwice) line('For this step, press the target first, then press Esc again to end.')
	if (!stepDef.escTwice)
		line('Pressing only Esc records an empty capture (useful when terminal/OS intercepts the target).')
}

function buildMatrix(steps: CaptureStep[], profiles: ProfileRun[]) {
	const matrix: Record<string, Record<string, any>> = {}
	for (const stepDef of steps) {
		const row: Record<string, any> = {}
		for (const p of profiles) {
			const found = p.steps.find((s) => s.stepId === stepDef.id)
			if (!found) continue
			row[p.id] = {
				status: found.status,
				hex: found.hex,
				display: found.display,
				tokenKinds: found.tokenKinds,
			}
		}
		matrix[stepDef.id] = row
	}
	return matrix
}

async function loadExistingCapture(path: string): Promise<any | null> {
	try {
		const raw = await readFile(path, 'utf8')
		if (!raw.trim()) return null
		return parse(raw)
	} catch {
		return null
	}
}

function mergeCaptureDocument(existing: any, nextDoc: any, allSteps: CaptureStep[]): any {
	if (!existing || typeof existing !== 'object') return nextDoc
	const merged: any = { ...existing, ...nextDoc }
	const existingProfiles = Array.isArray(existing.profiles) ? existing.profiles.map((p: any) => ({ ...p })) : []
	const byId = new Map<string, any>()
	for (const p of existingProfiles) {
		if (p && typeof p.id === 'string') byId.set(p.id, p)
	}
	for (const p of nextDoc.profiles ?? []) {
		if (!p || typeof p.id !== 'string') continue
		const target = byId.get(p.id) ?? { id: p.id, steps: [] }
		target.label = p.label
		if ('enable' in p) target.enable = p.enable
		if ('disable' in p) target.disable = p.disable
		if (p.calibration) target.calibration = p.calibration
		const steps = Array.isArray(target.steps) ? [...target.steps] : []
		for (const step of p.steps ?? []) {
			const idx = steps.findIndex((s: any) => s?.stepId === step.stepId)
			if (idx >= 0) steps[idx] = step
			else steps.push(step)
		}
		target.steps = steps
		byId.set(p.id, target)
	}
	merged.steps = stepDescriptors(allSteps)
	merged.profiles = [...byId.values()]
	merged.matrix = buildMatrix(allSteps, merged.profiles as ProfileRun[])
	return merged
}

function envSnapshot() {
	return {
		platform: process.platform,
		arch: process.arch,
		pid: process.pid,
		term: process.env.TERM ?? '',
		termProgram: process.env.TERM_PROGRAM ?? '',
		termProgramVersion: process.env.TERM_PROGRAM_VERSION ?? '',
		kittyPid: process.env.KITTY_PID ?? '',
		lang: process.env.LANG ?? '',
	}
}

async function main(): Promise<void> {
	const opts = parseArgs(Bun.argv.slice(2))
	if (opts.help) {
		printHelp()
		return
	}
	if (opts.listSteps) {
		listSteps(opts.preset)
		return
	}
		const allSteps = PRESET_STEPS[opts.preset]
		const selected = opts.step ? resolveSelectedStep(allSteps, opts.step) : null
		const steps = selected ? [selected.step] : allSteps
		const terminalLabel = opts.terminalLabel || defaultTerminalLabel()
		const outPath = resolve(opts.outPath || defaultOutPath(terminalLabel))
		const profiles = opts.profiles.map(profileById)
	const queue = new RawInputQueue()
	let activeProfile: CaptureProfile | null = null
	let rawModeEnabled = false
	const restore = async () => {
		try {
			if (activeProfile) await clearProfile(activeProfile)
		} catch {}
		activeProfile = null
		try {
			queue.stop()
		} catch {}
		try {
			if (rawModeEnabled && stdin.isTTY) stdin.setRawMode(false)
		} catch {}
		rawModeEnabled = false
		try {
			stdin.pause()
		} catch {}
	}
	process.on('exit', () => {
		try {
			if (stdin.isTTY) stdin.setRawMode(false)
		} catch {}
		try {
			directWrite(KITTY_DISABLE)
		} catch {}
	})
	try {
		line('HAL TUI key capture')
			line(`Preset: ${opts.preset} (${steps.length} steps)`)
			line(`Profiles: ${profiles.map((p) => p.id).join(', ')}`)
			line(`Output: ${outPath}`)
			line(`Terminal label: ${terminalLabel}`)
			if (selected) line(`Step mode: only step ${selected.index + 1} (${selected.step.id})`)
			line()
			line('Tip: clear clipboard before Cmd-V steps if you want shorter captures.')
		line('The script is now entering raw mode.')
		stdin.resume()
		if (stdin.isTTY) {
			stdin.setRawMode(true)
			rawModeEnabled = true
		}
		queue.start()
		const profileRuns: ProfileRun[] = []
		for (const profile of profiles) {
			activeProfile = profile
			await applyProfile(profile)
			await drainInput(queue)
			const { delimiter, calibration } = await runCalibration(queue, profile, opts)
			const stepResults: StepCapture[] = []
			if (delimiter) {
				for (let i = 0; i < steps.length; i++) {
					const stepDef = steps[i]
					await drainInput(queue)
						printStepPrompt(i, steps.length, stepDef)
						const timeoutMs = stepDef.timeoutMs ?? opts.stepTimeoutMs
						const result = await captureStepUntilDelimiter(queue, delimiter, timeoutMs, {
							endDelimiterCount: stepDef.escTwice ? 2 : 1,
						})
					const sum = summarizeBytes(result.payload)
					const record: StepCapture = {
						stepId: stepDef.id,
						label: stepDef.label,
						category: stepDef.category,
						status: result.status,
						note: stepDef.note,
						timeoutMs,
						durationMs: result.durationMs,
						delimiterHex: bytesToHex(delimiter),
						bytes: sum.bytes,
						hex: sum.hex,
						text: sum.text,
						display: sum.display,
						tokens: sum.tokens,
						tokenKinds: sum.tokenKinds,
					}
					stepResults.push(record)
					const statusLabel =
						record.status === 'captured' ? 'captured'
						: record.status === 'empty' ? 'empty'
						: 'timeout'
					line(`[${statusLabel}] ${record.hex ? `[${record.hex}] ` : ''}${record.display || '(none)'}`)
				}
			}
			profileRuns.push({
				id: profile.id,
				label: profile.label,
				enable: profile.enable ? escapeAsonString(profile.enable) : undefined,
				disable: profile.disable ? escapeAsonString(profile.disable) : undefined,
				calibration,
				steps: stepResults,
			})
			await clearProfile(profile)
			activeProfile = null
			await drainInput(queue)
		}
		await mkdir(dirname(outPath), { recursive: true })
			let document: any = {
				type: 'terminal-key-capture',
				version: 1,
				createdAt: new Date().toISOString(),
			terminalLabel,
			env: envSnapshot(),
			config: {
				preset: opts.preset,
				profiles: profiles.map((p) => p.id),
				stepTimeoutMs: opts.stepTimeoutMs,
				calibrationTimeoutMs: opts.calibrationTimeoutMs,
				idleMs: opts.idleMs,
			},
				steps: stepDescriptors(allSteps),
				profiles: profileRuns,
				matrix: buildMatrix(allSteps, profileRuns),
			}
			if (selected) {
				const existing = await loadExistingCapture(outPath)
				document = mergeCaptureDocument(existing, document, allSteps)
			}
			await writeFile(outPath, stringify(document, 'long') + '\n', 'utf8')
		line()
		line(`[done] Wrote capture to ${outPath}`)
		line('You can run this in each terminal (kitty/ghostty/iTerm/Terminal.app) with different --terminal labels.')
	} finally {
		await restore()
	}
}

main().catch(async (err) => {
	try {
		if (stdin.isTTY) stdin.setRawMode(false)
	} catch {}
	try {
		directWrite(KITTY_DISABLE)
	} catch {}
	stdout.write(`\n[error] ${err instanceof Error ? err.stack || err.message : String(err)}\n`)
	process.exitCode = 1
})
