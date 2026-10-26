// Owns durable schedules; execution remains ordinary sessions, turns and tools.
import { mkdirSync, statSync } from 'fs'
import { scheduleTime } from '../common/schedule-time.ts'
import { session } from '../common/session.ts'
import { clients } from './clients.ts'
import { clock } from './clock.ts'
import { history } from './history.ts'
import { liveFiles } from './live-file.ts'
import { models } from './models.ts'
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
import { autoclose } from './autoclose.ts'

export type Run = { at: number; session?: string; after?: number; ended?: number; result?: string; takeover?: boolean }
export type Job = {
	id: number
	when: string
	prompt: string
	cwd: string
	timezone: string
	model: string
	history: 'fresh' | 'continue'
	autoclose: boolean
	timeout?: string
	paused: boolean
	next: number
	runs: Run[]
	changed: { at: number; session: string; by: string }
}
type Store = { serial: number; jobs: Job[] }
type Options = Pick<Job, 'when' | 'prompt' | 'cwd' | 'timezone' | 'model' | 'history' | 'autoclose' | 'timeout'>

function options(value: Record<string, unknown>): Options {
	let keys = ['when', 'prompt', 'cwd', 'timezone', 'model', 'history', 'autoclose', 'timeout']
	for (let key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown schedule setting: ${key}`)
	for (let key of ['when', 'prompt', 'cwd', 'timezone', 'model', 'history'])
		if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Schedule ${key} needs text.`)
	if (!clients.zone(value.timezone)) throw new Error('Schedule needs your IANA timezone, such as Europe/Helsinki.')
	if (!['fresh', 'continue'].includes(value.history as string)) throw new Error('history must be fresh or continue.')
	if (typeof value.autoclose !== 'boolean') throw new Error('autoclose must be true or false.')
	if (value.timeout !== undefined && value.timeout !== '') {
		if (typeof value.timeout !== 'string') throw new Error('timeout needs a duration, such as 30m.')
		scheduleTime.duration(value.timeout)
	}
	let model = value.model as string
	if (!['default', 'openai', 'claude'].includes(model) && !model.includes('/'))
		throw new Error('Use default, openai, claude, or an exact provider/model[:effort].')
	return {
		...value,
		when: scheduleTime.format(scheduleTime.parse(value.when as string)),
		timeout: value.timeout || undefined,
	} as Options
}

function file(): Store {
	if (scheduler.state.file) return scheduler.state.file
	mkdirSync(paths.stateDir(), { recursive: true })
	let path = `${paths.stateDir()}/schedule.ason`
	let data = liveFiles.liveFile<Store>(path, { serial: 0, jobs: [] }, { watch: false })
	try {
		if (!Number.isSafeInteger(data.serial) || data.serial < 0 || !Array.isArray(data.jobs))
			throw new Error('invalid job store')
		let ids = new Set<number>()
		for (let j of data.jobs) {
			scheduler.options(
				Object.fromEntries(
					['when', 'prompt', 'cwd', 'timezone', 'model', 'history', 'autoclose', 'timeout'].map((k) => [
						k,
						j[k as keyof Job],
					]),
				),
			)
			if (
				!Number.isSafeInteger(j.id) ||
				j.id < 1 ||
				j.id > data.serial ||
				ids.has(j.id) ||
				typeof j.paused !== 'boolean' ||
				!Number.isFinite(j.next) ||
				!Array.isArray(j.runs) ||
				!j.changed ||
				typeof j.changed.session !== 'string' ||
				typeof j.changed.by !== 'string' ||
				!Number.isFinite(j.changed.at)
			)
				throw new Error('invalid job state')
			ids.add(j.id)
			for (let [i, r] of j.runs.entries())
				if (
					!Number.isFinite(r.at) ||
					(r.ended !== undefined && !Number.isFinite(r.ended)) ||
					(r.ended === undefined && i !== j.runs.length - 1) ||
					(r.session !== undefined && (typeof r.session !== 'string' || !session.isId(r.session))) ||
					(r.result !== undefined && typeof r.result !== 'string') ||
					(r.takeover !== undefined && typeof r.takeover !== 'boolean')
				)
					throw new Error('invalid run state')
			for (let r of j.runs)
				if (r.after !== undefined && (!Number.isSafeInteger(r.after) || r.after < 0))
					throw new Error('invalid run history boundary')
		}
	} catch (e) {
		liveFiles.close(data)
		throw new Error(`${path}: ${e instanceof Error ? e.message : e}`)
	}
	scheduler.state.file = data
	return data
}

function active(j: Job): Run | undefined {
	let run = j.runs.at(-1)
	return run && run.ended === undefined ? run : undefined
}

function save(): void {
	liveFiles.save(scheduler.file())
}

function finish(j: Job, run: Run, result: string): void {
	run.ended = clock.now()
	run.result = result
	scheduler.save()
	if (result !== 'completed') {
		let text = `Schedule ${j.id}: ${result}`
		if (run.session) slash.output(run.session, text, true)
		warnings.tell({ type: 'warning', text })
	}
}

function run(j: Job): void {
	if (scheduler.active(j)) throw new Error(`Schedule ${j.id} already has an active run.`)
	let previous = j.runs.at(-1)?.session
	if (j.history === 'continue' && previous && work.active({ sessionId: previous, ref: previous }))
		throw new Error(`The previous session is still busy: ${previous}`)
	let run: Run = { at: clock.now() }
	j.runs.push(run)
	run = j.runs.at(-1)!
	scheduler.save()
	try {
		if (!statSync(j.cwd).isDirectory()) throw new Error(`Not a directory: ${j.cwd}`)
		let model = j.model === 'default' ? models.defaultModel() : j.model
		let selection = models.selection(model)
		if (!models.valid(selection.id)) throw new Error(`Unavailable scheduled model: ${model}`)
		let id = j.history === 'continue' ? previous : undefined
		if (id) {
			let meta = sessions.open(id)
			delete meta.projectTrust
			meta.interactive = false
			meta.autoclose = j.autoclose
			slash.change(id, { cwd: j.cwd, model: models.qualified(selection.id, selection.effort) })
			tabs.resume(id)
		} else {
			id = sessions.create({
				cwd: j.cwd,
				model: models.qualified(selection.id, selection.effort),
				interactive: false,
				autoclose: j.autoclose,
			}).id
			tabs.insert(id, tabs.file().open.length)
		}
		run.session = id
		run.after = history.readSync(id).at(-1)?.n ?? 0
		liveFiles.save(sessions.open(id))
		scheduler.save()
		tabs.publish()
		let refused = prompts.submit(id, j.prompt, undefined, 'steer', { interactive: false, label: `Schedule ${j.id}` })
		if (refused) throw new Error(refused)
	} catch (e) {
		scheduler.finish(j, run, e instanceof Error ? (e.stack ?? e.message) : String(e))
	}
}

function tick(): void {
	let now = clock.now()
	for (let j of scheduler.file().jobs) {
		let run = scheduler.active(j)
		// Consume due occurrences before releasing an active run: none wait behind it.
		let due = !j.paused && j.next <= now
		if (due) {
			let timing = scheduleTime.parse(j.when)
			j.next =
				'every' in timing
					? j.next + (Math.floor((now - j.next) / timing.every) + 1) * timing.every
					: scheduleTime.next(timing, now, j.timezone)
			scheduler.save()
		}
		if (run?.session) {
			let id = run.session
			if (!run.takeover && !run.result && j.timeout && now >= run.at + scheduleTime.duration(j.timeout)) {
				run.result = `Timed out after ${j.timeout}\n${work.stop({ sessionId: id, ref: id })}`
				if (notify.asked(id)) turns.stop(id, 'Scheduled run timed out', true)
			}
			if (
				!turns.state.running.has(id) &&
				!work.tree({ sessionId: id, ref: id }).some(work.active) &&
				(!notify.asked(id) || run.result)
			) {
				let state = status.stateOf(id)
				if (state.type !== 'blocked')
					scheduler.finish(
						j,
						run,
						run.result ?? (state.type === 'idle' ? 'completed' : state.type === 'error' ? state.message : state.type),
					)
			}
		}
		if (due && !run) scheduler.run(j)
	}
}

function owned(id: string): Job | undefined {
	return scheduler.state.file?.jobs.find((j) => {
		let run = scheduler.active(j)
		return run?.session === id && !run.takeover
	})
}

function takeover(id: string): void {
	for (let j of scheduler.state.file?.jobs ?? []) {
		let run = scheduler.active(j)
		if (run?.session !== id || run.takeover) continue
		run.takeover = true
		autoclose.set(id, false)
		slash.output(id, `Schedule ${j.id}: human control; timeout and autoclose disabled.`)
		scheduler.save()
	}
}

function recover(): void {
	for (let j of scheduler.file().jobs) {
		let run = scheduler.active(j)
		if (!run || run.takeover) continue
		if (run.session) {
			let last = history.readSync(run.session).findLast((r) => r.type === 'turn_end')
			if (
				last?.type === 'turn_end' &&
				(last.n ?? 0) > (run.after ?? Infinity) &&
				last.status === 'completed' &&
				!history.unfinished(run.session) &&
				!work.tree({ sessionId: run.session, ref: run.session }).some(work.active) &&
				!notify.asked(run.session)
			) {
				scheduler.finish(j, run, run.result ?? 'completed')
				continue
			}
		}
		if (run.session) work.stop({ sessionId: run.session, ref: run.session })
		scheduler.finish(j, run, 'Interrupted by host restart; not retried automatically')
		j.next = scheduleTime.next(scheduleTime.parse(j.when), clock.now(), j.timezone)
	}
	scheduler.save()
}

function init(): void {
	if (scheduler.state.timer) return
	scheduler.recover()
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
}

function reset(): void {
	if (scheduler.state.timer) clearInterval(scheduler.state.timer)
	if (scheduler.state.file) liveFiles.close(scheduler.state.file)
	scheduler.state = {}
}

export const scheduler = {
	state: {} as { file?: Store; timer?: ReturnType<typeof setInterval> },
	options,
	file,
	active,
	save,
	finish,
	run,
	tick,
	owned,
	takeover,
	recover,
	init,
	reset,
}
