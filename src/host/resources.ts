// Watches free disk space in the home and available memory, so a full
// disk or an out-of-memory kill never takes Hal and its sessions down
// unannounced. Every intervalMs the host measures
// both and grades them ok, low or critical. Entering a worse level warns
// every client (and each one joining while it lasts); recovery tells them
// too. While critical, every running turn is paused with the reason, which
// also kills its commands; models learn only through that reason. The user
// decides when to resume. Task: fwk.
import { readFileSync, statfsSync } from 'fs'
import { freemem, totalmem } from 'os'
import { host } from './host.ts'
import { paths } from './paths.ts'
import { turns } from './turns.ts'
import { warnings } from './warnings.ts'

export type Level = 'ok' | 'low' | 'critical'
type Sample = { disk: number; memory: number }

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

// One check: grades a fresh sample, pauses running turns while critical
// (also those started after it began) and warns clients on a change.
function check(sample = resources.measure()): void {
	let st = resources.state
	let before = st.level
	st.sample = sample
	st.level = resources.grade(sample)
	if (st.level === 'critical') for (let [id, running] of turns.state.running) {
		if (running.controller.signal.aborted) continue
		try { turns.stop(id, `${resources.describe(sample, 'critical')}. Free space, then resume.`) }
		catch (e) { process.stderr.write(`resource pause for ${id}: ${e instanceof Error ? e.stack : e}\n`) }
	}
	if (st.level === before) return
	warnings.set('resources', resources.warning())
	if (st.level === 'ok') for (let client of host.state.clients) client.deliver({ type: 'warning', text: `Resources recovered: disk ${gb(sample.disk)} free, memory ${gb(sample.memory)} available` })
}

// Checks now and every intervalMs; clients joining while short get the
// warning. Idempotent; the host calls it once it serves.
function init(): void {
	let st = resources.state
	if (st.timer) return
	let run = () => {
		try {
			resources.check()
		} catch (e) {
			for (let client of host.state.clients) client.deliver({ type: 'warning', text: `Resource check failed: ${e instanceof Error ? e.stack : e}` })
		}
	}
	st.timer = setInterval(run, resources.intervalMs)
	st.timer.unref?.()
	run()
}

function stop(): void {
	clearInterval(resources.state.timer)
	resources.state = { level: 'ok', timer: undefined, sample: undefined }
}

export const resources = {
	state: { level: 'ok' as Level, timer: undefined as ReturnType<typeof setInterval> | undefined, sample: undefined as Sample | undefined },
	intervalMs: 30_000,
	lowDiskBytes: 5e9,
	criticalDiskBytes: 1e9,
	lowMemoryBytes: 1.5e9,
	criticalMemoryBytes: 0.5e9,
	availableMemory, measure, grade, describe, warning, check, init, stop,
}
