// Runs durable jobs through ordinary sessions, without overlapping or replaying uncertain work.
import { mkdirSync, statSync } from 'fs'
import { scheduleTime } from '../common/schedule-time.ts'
import { session } from '../common/session.ts'
import { clients } from './clients.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'
import { prompts } from './prompts.ts'
import { sessions } from './sessions.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { tabs } from './tabs.ts'
import { turns } from './turns.ts'
import { notify } from './notify.ts'
import { warnings } from './warnings.ts'
import { work } from './work.ts'

type Run = { session?: string; result?: string; takeover?: boolean }
const keys = ['when', 'prompt', 'cwd', 'timezone', 'model'] as const
export type Job = Record<(typeof keys)[number], string> & {
	id: number
	paused: boolean
	next: number
	run?: Run
}
type Store = { serial: number; jobs: Job[] }
export const scheduler = {
	state: {} as { file?: Store; timer?: ReturnType<typeof setInterval> },
	keys,
	options(value: Record<string, unknown>) {
		for (let key of Object.keys(value))
			if (!scheduler.keys.includes(key as (typeof scheduler.keys)[number])) throw new Error(`Unknown setting: ${key}`)
		for (let key of scheduler.keys)
			if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Schedule ${key} needs text.`)
		if (!clients.zone(value.timezone)) throw new Error('Schedule needs your IANA timezone, such as Europe/Helsinki.')
		scheduleTime.parse(String(value.when))
		return value as Pick<Job, (typeof scheduler.keys)[number]>
	},
	file(): Store {
		if (scheduler.state.file) return scheduler.state.file
		mkdirSync(paths.stateDir(), { recursive: true })
		let path = `${paths.stateDir()}/schedule.ason`
		let data = liveFiles.liveFile<Store>(path, { serial: 0, jobs: [] }, { watch: false })
		try {
			if (!Number.isSafeInteger(data.serial) || data.serial < 0 || !Array.isArray(data.jobs))
				throw new Error('invalid store')
			let ids = new Set<number>()
			for (let j of data.jobs) {
				scheduler.options(Object.fromEntries(scheduler.keys.map((key) => [key, j[key]])))
				if (
					!Number.isSafeInteger(j.id) ||
					j.id < 1 ||
					j.id > data.serial ||
					ids.has(j.id) ||
					typeof j.paused !== 'boolean' ||
					!Number.isFinite(j.next)
				)
					throw new Error('invalid job state')
				ids.add(j.id)
				let r = j.run
				if (r !== undefined && (!r || typeof r !== 'object' || Array.isArray(r))) throw new Error('invalid run state')
				if (
					r &&
					((r.session !== undefined && (typeof r.session !== 'string' || !session.isId(r.session))) ||
						(r.takeover !== undefined && typeof r.takeover !== 'boolean') ||
						(r.result !== undefined && typeof r.result !== 'string'))
				)
					throw new Error('invalid run state')
			}
		} catch (e) {
			liveFiles.close(data)
			throw new Error(`${path}: ${e instanceof Error ? e.message : e}`)
		}
		return (scheduler.state.file = data)
	},
	save() {
		liveFiles.save(scheduler.file())
	},
	active(j: Job) {
		return j.run?.result === undefined ? j.run : undefined
	},
	busy(id: string) {
		return turns.state.running.has(id) || work.tree({ sessionId: id, ref: id }).some(work.active) || notify.asked(id)
	},
	finish(j: Job, result: string) {
		j.run!.result = result
		scheduler.save()
		if (result !== 'completed') {
			let text = `Schedule ${j.id}: ${result}`
			if (j.run!.session) slash.output(j.run!.session!, text, true)
			warnings.tell({ type: 'warning', text })
		}
	},
	run(j: Job) {
		if (scheduler.active(j)) return
		j.run = {}
		scheduler.save()
		try {
			if (!statSync(j.cwd).isDirectory()) throw new Error(`Not a directory: ${j.cwd}`)
			let meta = sessions.create({
				cwd: j.cwd,
				model: j.model === 'default' ? undefined : j.model,
				interactive: false,
				autoclose: true,
			})
			j.run!.session = meta.id
			scheduler.save()
			tabs.resume(meta.id)
			tabs.publish()
			let refused = prompts.submit(meta.id, j.prompt, undefined, 'steer', {
				interactive: false,
				label: `Schedule ${j.id}`,
			})
			if (refused) throw new Error(refused)
		} catch (e) {
			scheduler.finish(j, e instanceof Error ? (e.stack ?? e.message) : String(e))
		}
	},
	tick(recover = false) {
		let now = clock.now()
		for (let j of scheduler.file().jobs) {
			let run = scheduler.active(j),
				id = run?.session
			let due = !j.paused && j.next <= now
			if ((!recover && due) || (recover && run && !run.takeover)) {
				let timing = scheduleTime.parse(j.when)
				j.next =
					'every' in timing && due
						? j.next + (Math.floor((now - j.next) / timing.every) + 1) * timing.every
						: scheduleTime.next(timing, now, j.timezone)
				scheduler.save()
			}
			if (recover && run && !run.takeover) {
				let last = id ? history.readSync(id).findLast((r) => r.type === 'turn_end') : undefined
				let completed = last?.status === 'completed' && !history.unfinished(id!) && !scheduler.busy(id!)
				if (!completed && id) {
					work.stop({ sessionId: id, ref: id })
					if (notify.asked(id)) turns.stop(id, 'Scheduled run interrupted', true)
				}
				scheduler.finish(j, completed ? 'completed' : 'Interrupted by host restart; not retried automatically')
			} else if (id && !scheduler.busy(id)) {
				let state = status.stateOf(id)
				scheduler.finish(j, state.type === 'idle' ? 'completed' : state.type === 'error' ? state.message : state.type)
			}
			if (due && !run && !recover) scheduler.run(j)
		}
	},
	owned(id: string) {
		return scheduler.state.file?.jobs.find((j) => scheduler.active(j)?.session === id && !j.run?.takeover)
	},
	takeover(id: string) {
		let j = scheduler.owned(id)
		if (!j) return
		j.run!.takeover = true
		slash.output(id, `Schedule ${j.id}: human control.`)
		scheduler.save()
	},
	init() {
		if (scheduler.state.timer) return
		scheduler.tick(true)
		let tick = () => {
			try {
				scheduler.tick()
			} catch (e) {
				warnings.set('schedule', `Scheduler: ${e instanceof Error ? (e.stack ?? e.message) : e}`)
			}
		}
		scheduler.state.timer = setInterval(tick, 1000)
		scheduler.state.timer.unref()
		tick()
	},
	reset() {
		if (scheduler.state.timer) clearInterval(scheduler.state.timer)
		if (scheduler.state.file) liveFiles.close(scheduler.state.file)
		scheduler.state = {}
	},
}
