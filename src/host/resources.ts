// Watches free disk space in the home and available memory, so a full
// disk or an out-of-memory kill never takes Hal and its sessions down
// unannounced. Every intervalMs the host measures
// both and grades them ok, low or critical. Entering a worse level warns
// every client (and each one joining while it lasts); each session's next
// bash result carries one note per level it has not been told; entering
// critical pauses every running turn with the reason, which also kills
// their commands. The user decides when to resume. In memory only.
// Tasks: fwk.
import { readFileSync, statfsSync } from 'fs'
import { freemem } from 'os'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { turns } from './turns.ts'

export type Level = 'ok' | 'low' | 'critical'
type Sample = { disk: number; memory: number }

const rank: Record<Level, number> = { ok: 0, low: 1, critical: 2 }
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

// Free bytes for unprivileged writers in the home, and memory the kernel
// can hand out without swapping (MemAvailable; freemem() off Linux).
function measure(): Sample {
	let fs = statfsSync(paths.home())
	let memory = freemem()
	try {
		let m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
		if (m) memory = Number(m[1]) * 1024
	} catch {}
	return { disk: fs.bavail * fs.bsize, memory }
}

function grade(s: Sample): Level {
	let r = resources
	if (s.disk < r.criticalDiskBytes || s.memory < r.criticalMemoryBytes) return 'critical'
	if (s.disk < r.lowDiskBytes || s.memory < r.lowMemoryBytes) return 'low'
	return 'ok'
}

// What is short, in words: "disk 3.2 GB free in /root/hal (low under 5.0 GB)".
function describe(s: Sample, level: Level): string {
	let r = resources
	let parts: string[] = []
	let diskLimit = level === 'critical' ? r.criticalDiskBytes : r.lowDiskBytes
	let memoryLimit = level === 'critical' ? r.criticalMemoryBytes : r.lowMemoryBytes
	if (s.disk < diskLimit) parts.push(`disk ${gb(s.disk)} free in ${paths.home()} (${level} under ${gb(diskLimit)})`)
	if (s.memory < memoryLimit) parts.push(`memory ${gb(s.memory)} available (${level} under ${gb(memoryLimit)})`)
	return parts.join('; ')
}

function warning(): string | undefined {
	let { level, sample } = resources.state
	if (level === 'ok' || !sample) return undefined
	return `${level === 'critical' ? 'Critically low' : 'Low'} resources: ${resources.describe(sample, level)}`
}

// One check: grades a fresh sample and acts on a change of level.
function check(sample = resources.measure()): void {
	let st = resources.state
	let before = st.level
	st.sample = sample
	st.level = resources.grade(sample)
	if (st.level === before) return
	diag.log(`resources: ${before} -> ${st.level} (disk ${gb(sample.disk)}, memory ${gb(sample.memory)})`)
	if (st.level === 'ok') st.told.clear()
	let text = resources.warning() ?? `Resources recovered: disk ${gb(sample.disk)} free, memory ${gb(sample.memory)} available`
	if (rank[st.level] > rank[before] || st.level === 'ok') for (let client of host.state.clients) client.deliver({ type: 'warning', text })
	if (st.level !== 'critical') return
	let reason = `${resources.describe(sample, 'critical')}. Free space, then resume.`
	for (let id of turns.state.running.keys()) turns.stop(id, reason)
}

// The bash result with a note if this session has not heard of the
// current level yet (once per level, again after recovery).
function append(output: string, sessionId: string): string {
	let { level, sample, told } = resources.state
	if (level === 'ok' || !sample || rank[told.get(sessionId) ?? 'ok'] >= rank[level]) return output
	told.set(sessionId, level)
	let line = `[Hal: ${level} resources: ${resources.describe(sample, level)}. Avoid large copies, builds and downloads; delete temp files you made.]`
	return `${output}${output.endsWith('\n') || !output ? '' : '\n'}${line}`
}

// Checks now and every intervalMs; clients joining while short get the
// warning. Idempotent; the host calls it once it serves.
function init(): void {
	let st = resources.state
	if (st.timer) return
	let warn = host.warn
	host.warn = (client) => {
		warn(client)
		let text = resources.warning()
		if (text) client.deliver({ type: 'warning', text })
	}
	let run = () => {
		try {
			resources.check()
		} catch (e: any) {
			diag.log(`resources: ${e?.message ?? e}`)
		}
	}
	st.timer = setInterval(run, resources.intervalMs)
	st.timer.unref?.()
	run()
}

function stop(): void {
	clearInterval(resources.state.timer)
	resources.state = { level: 'ok', told: new Map(), timer: undefined, sample: undefined }
}

export const resources = {
	state: { level: 'ok' as Level, told: new Map<string, Level>(), timer: undefined as ReturnType<typeof setInterval> | undefined, sample: undefined as Sample | undefined },
	intervalMs: 30_000,
	lowDiskBytes: 5e9,
	criticalDiskBytes: 1e9,
	lowMemoryBytes: 1.5e9,
	criticalMemoryBytes: 0.5e9,
	measure, grade, describe, warning, check, append, init, stop,
}
