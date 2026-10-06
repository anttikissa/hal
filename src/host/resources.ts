// Measures host disk and memory; level transitions reach clients and each
// open session's durable notices. Critical levels pause running turns.
// New sessions learn the current shortage before their first request.
// Tasks: fwk, nvm.
import { readFileSync, statfsSync } from 'fs'
import { freemem, totalmem } from 'os'
import { diag } from './diag.ts'
import { host } from './host.ts'
import { history } from './history.ts'
import { sessions, type SessionMeta } from './sessions.ts'
import { paths } from './paths.ts'
import { turns } from './turns.ts'

export type Level = 'ok' | 'low' | 'critical'
type Sample = { disk: number; memory: number }

const rank: Record<Level, number> = { ok: 0, low: 1, critical: 2 }
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

// Memory the kernel can hand out without swapping. Linux: MemAvailable.
// macOS: freemem() counts only idle pages and ignores reclaimable cache,
// so it reads near zero on a healthy Mac; kern.memorystatus_level is the
// available percentage that memory_pressure reports. freemem() elsewhere.
function availableMemory(): number {
	try {
		let m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'))
		if (m) return Number(m[1]) * 1024
	} catch {}
	if (process.platform === 'darwin') {
		let out = Bun.spawnSync(['sysctl', '-n', 'kern.memorystatus_level']).stdout.toString()
		let percent = Number.parseInt(out, 10)
		if (percent >= 0 && percent <= 100) return (totalmem() * percent) / 100
	}
	return freemem()
}

// Free bytes for unprivileged writers in the home, and available memory.
function measure(): Sample {
	let fs = statfsSync(paths.home())
	return { disk: fs.bavail * fs.bsize, memory: availableMemory() }
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
	st.told = new WeakSet()
	let text = resources.warning() ?? resources.text()!
	if (rank[st.level] > rank[before] || st.level === 'ok') for (let client of host.state.clients) client.deliver({ type: 'warning', text })
	try {
		for (let id of sessions.state.open.keys()) {
			history.append(id, { type: 'notice', text: resources.text()! })
			st.told.add(sessions.open(id))
		}
	} finally {
		// A full disk can reject the notice itself; still stop resource users.
		if (st.level === 'critical') {
			let reason = `${resources.describe(sample, 'critical')}. Free space, then resume.`
			for (let [id, running] of turns.state.running) {
				try {
					turns.stop(id, reason, true)
				} catch (error) {
					resources.report(error)
				} finally {
					delete running.steered
					running.controller.abort()
				}
			}
		}
	}
}

// Facts only: recovery is a transition too, not advice hidden in tool output.
function text(): string | undefined {
	let { level, sample } = resources.state
	if (!sample) return undefined
	return level === 'ok'
		? `Resources recovered: disk ${gb(sample.disk)} free, memory ${gb(sample.memory)} available`
		: `${level} resources: ${resources.describe(sample, level)}`
}

// Called before history.messages reads records. Weak identities do not retain
// closed sessions, and reopening during a shortage gets the current fact.
function notice(id: string): void {
	let st = resources.state
	if (st.level === 'ok' || !st.sample) return
	let meta = sessions.open(id)
	if (st.told.has(meta)) return
	history.append(id, { type: 'notice', text: resources.text()! })
	st.told.add(meta)
}

// Checks now and every intervalMs; clients joining while short get the
// warning. Idempotent; the host calls it once it serves.
function report(error: unknown): void {
	let text = `Resource check failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
	diag.log(text)
	for (let client of host.state.clients) client.deliver({ type: 'warning', text })
}

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
		} catch (error) {
			resources.report(error)
		}
	}
	st.timer = setInterval(run, resources.intervalMs)
	st.timer.unref?.()
	run()
}

function stop(): void {
	clearInterval(resources.state.timer)
	resources.state = { level: 'ok', told: new WeakSet(), timer: undefined, sample: undefined }
}

export const resources = {
	state: { level: 'ok' as Level, told: new WeakSet<SessionMeta>(), timer: undefined as ReturnType<typeof setInterval> | undefined, sample: undefined as Sample | undefined },
	intervalMs: 30_000,
	lowDiskBytes: 5e9,
	criticalDiskBytes: 1e9,
	lowMemoryBytes: 1.5e9,
	criticalMemoryBytes: 0.5e9,
	availableMemory, measure, grade, describe, warning, check, text, notice, report, init, stop,
}
