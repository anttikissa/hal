// /schedule manages saved jobs in the same transcript and forms on both clients.
import { ason } from '../../common/ason.ts'
import type { Form } from '../../common/forms.ts'
import { scheduleTime } from '../../common/schedule-time.ts'
import { settings } from '../../common/settings.ts'
import { clients } from '../clients.ts'
import { clock } from '../clock.ts'
import { commands, type SlashCommand } from '../commands.ts'
import { scheduler, type Job, type Run } from '../scheduler.ts'
import { tabs } from '../tabs.ts'
import { models } from '../models.ts'
import { work } from '../work.ts'

const operations = ['list', 'show', 'add', 'edit', 'pause', 'resume', 'run', 'stop', 'remove']
const keys = ['when', 'prompt', 'cwd', 'timezone', 'model', 'history', 'autoclose', 'timeout'] as const

function time(at: number, timezone: string): string {
	return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(at)
}
function link(run?: Run): string {
	if (!run?.session) return 'none'
	let n = tabs.file().open.indexOf(run.session)
	return `[${n < 0 ? run.session + ' (closed)' : `tab ${n + 1}`}](${settings.webUrl().replace(/\/$/, '')}/${run.session})`
}
function show(j: Job, detail = false): string {
	let active = scheduler.active(j),
		last = j.runs.at(-1)
	let lines = [
		`${j.id}. ${j.paused ? 'Paused' : active ? 'Running' : 'Waiting'} - ${j.prompt.split('\n')[0]!.slice(0, 100)}`,
		`   ${j.when} | Next: ${j.paused ? 'none' : time(j.next, j.timezone)} | ${j.timezone}`,
		`   ${active ? 'Current' : 'Last'} run: ${link(last)}${last?.result ? ` - ${last.result}` : ''}`,
	]
	if (detail)
		lines.push(
			ason.stringify(Object.fromEntries(keys.map((k) => [k, j[k]]))),
			`Changed by ${j.changed.by} in ${j.changed.session} at ${time(j.changed.at, j.timezone)}`,
			'Past runs:',
			...j.runs.map(
				(r) =>
					`${time(r.at, j.timezone)} - ${link(r)} - ${r.result ?? 'running'}${r.takeover ? ' (human control)' : ''}`,
			),
		)
	return lines.join('\n')
}
function form(value: Record<string, unknown>): Form {
	return {
		text: 'Scheduled job',
		fields: keys.map((name) =>
			name === 'history' || name === 'autoclose'
				? {
						type: 'choice',
						name,
						options: name === 'history' ? ['fresh', 'continue'] : ['false', 'true'],
						initial: name === 'history' ? Number(value[name] === 'continue') : Number(value[name] === true),
					}
				: {
						type: 'text',
						name,
						initial: String(value[name] ?? ''),
						...(name === 'when' ? { help: '30m; hourly at :20; monday at 12:00; 09:00..19:00 every 1h' } : {}),
					},
		),
	}
}

export const command: SlashCommand = {
	help: () =>
		[
			'/schedule lists all jobs. /schedule ID (or show ID) shows settings and past runs.',
			'/schedule add { when: "30m", prompt: "Check tests" } creates a job; add alone opens a form.',
			'/schedule edit ID { when: "hourly at :20" } changes settings; edit ID opens a form.',
			'/schedule pause|resume|run|stop|remove ID. Pause prevents future runs; stop stops current work. Remove requires no active run.',
			'Optional settings: cwd, timezone (your client timezone by default), model (default, openai, claude, or provider/model[:effort]), history (fresh or continue), timeout (30m, blank disables), autoclose (false or true).',
			'Times: durations, hourly at :20, every :30, monday at 12:00, daily at 09:00, 17:00, or 09:00..19:00 every 1h. Ranges include both endpoints when aligned.',
			'Clock times use the saved user timezone. Repeated DST minutes run twice; missing minutes skip. Active jobs skip occurrences. Downtime catches up once; interrupted runs are not retried.',
		].join('\n'),
	complete(args) {
		let choices = [...operations, ...scheduler.file().jobs.map((j) => String(j.id))]
		for (let op of operations.filter((o) => !['list', 'add'].includes(o)))
			choices.push(...scheduler.file().jobs.map((j) => `${op} ${j.id}`))
		let prefix = /^(add|edit \d+)\s+\{\s*$/.exec(args)
		if (prefix) choices.push(...keys.map((k) => `${args}${k}: `))
		let field = /^(.*\b(model|history|autoclose):\s*)['"]?[^,'"}]*$/.exec(args)
		if (field)
			return (
				field[2] === 'model'
					? ['default', 'openai', 'claude', ...models.known()]
					: field[2] === 'history'
						? ['fresh', 'continue']
						: ['false', 'true']
			)
				.map((v) => `${field[1]}${field[2] === 'autoclose' ? v : `'${v}'`}`)
				.filter((v) => v.startsWith(args))
		return choices.filter((v) => v.startsWith(args))
	},
	run(args, answers, ctx) {
		let store = scheduler.file()
		if (!args || args === 'list')
			return { say: store.jobs.map((j) => show(j)).join('\n\n') || 'No scheduled jobs. /schedule add' }
		let m = /^(add|show|edit|pause|resume|run|stop|remove)?\s*(\d+)?\s*([\s\S]*)$/.exec(args)
		if (!m) return { error: command.help!('') }
		let op = m[1] ?? 'show',
			id = Number(m[2]),
			rest = m[3]!.trim()
		if ((!m[1] && !m[2]) || (op === 'add' && m[2])) return { error: command.help!('') }
		if (op !== 'add' && !m[2] && store.jobs.length) {
			if (answers?.job) {
				let selected = `${op} ${answers.job}`
				return Promise.resolve(command.run(selected, undefined, ctx)).then((reply) => ({
					...reply,
					...(reply.ask ? { askArgs: selected } : {}),
				}))
			}
			return {
				ask: {
					text: `Schedule to ${op}`,
					fields: [{ type: 'choice', name: 'job', options: store.jobs.map((j) => String(j.id)) }],
				},
			}
		}
		let j = store.jobs.find((j) => j.id === id)
		if (op !== 'add' && !j) return { error: `No schedule ${m[2] ?? ''}. /schedule lists jobs.` }
		if (op === 'show') return rest ? { error: 'Usage: /schedule show ID' } : { say: show(j!, true) }
		if (op === 'add' || op === 'edit') {
			let value: Record<string, unknown> = j
				? Object.fromEntries(keys.map((k) => [k, j![k]]))
				: {
						cwd: ctx.cwd,
						timezone: clients.timezone(ctx.sessionId) ?? '',
						model: 'default',
						history: 'fresh',
						autoclose: false,
					}
			if (!rest && !answers) return { ask: form(value) }
			let patch = answers ? { ...answers, autoclose: answers.autoclose === 'true' } : ason.parse(rest)
			if (!patch || typeof patch !== 'object' || Array.isArray(patch))
				return { error: 'Schedule settings must be an ASON object.' }
			Object.assign(value, patch)
			if (!value.when || !value.prompt || !value.timezone)
				return { ask: form(value), askArgs: op === 'add' ? 'add' : `edit ${id}` }
			if (typeof value.cwd === 'string') value.cwd = commands.expand(value.cwd, ctx.cwd)
			let options = scheduler.options(value)
			let next = scheduleTime.next(scheduleTime.parse(options.when), clock.now(), options.timezone)
			let changed = {
				at: clock.now(),
				session: ctx.sessionId,
				by: ctx.sender?.origin === 'model' ? 'model' : (ctx.sender?.from ?? 'user'),
			}
			if (j) Object.assign(j, options, { next, changed })
			else {
				store.jobs.push({ ...options, id: ++store.serial, paused: false, next, runs: [], changed })
				j = store.jobs.at(-1)!
			}
		} else {
			if (rest) return { error: `Usage: /schedule ${op} ID` }
			if (op === 'pause') j!.paused = true
			if (op === 'resume') {
				j!.paused = false
				j!.next = scheduleTime.next(scheduleTime.parse(j!.when), clock.now(), j!.timezone)
			}
			if (op === 'run') scheduler.run(j!)
			if (op === 'stop') {
				let run = scheduler.active(j!)
				if (!run?.session) return { error: 'No active run.' }
				run.result = `Stopped by ${ctx.sender?.origin === 'model' ? 'model' : 'user'}\n${work.stop({ sessionId: run.session, ref: run.session })}`
			}
			if (op === 'remove') {
				if (scheduler.active(j!)) return { error: 'Stop the active run before removing this job.' }
				store.jobs = store.jobs.filter((job) => job.id !== id)
			}
			j!.changed = {
				at: clock.now(),
				session: ctx.sessionId,
				by: ctx.sender?.origin === 'model' ? 'model' : (ctx.sender?.from ?? 'user'),
			}
		}
		scheduler.save()
		return {
			say: `${op === 'remove' ? `Removed schedule ${id}.` : show(j!, true)}\nOperation: ${op}; by ${j!.changed.by}.`,
		}
	},
}
