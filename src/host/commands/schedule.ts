// Manages jobs in the shared transcript; run output stays in ordinary session tabs.
import { ason } from '../../common/ason.ts'
import { scheduleTime } from '../../common/schedule-time.ts'
import { settings } from '../../common/settings.ts'
import { clients } from '../clients.ts'
import { clock } from '../clock.ts'
import { commands, type SlashCommand } from '../commands.ts'
import { scheduler, type Job } from '../scheduler.ts'
import { tabs } from '../tabs.ts'
import { models } from '../models.ts'

const operations = ['list', 'show', 'add', 'pause', 'resume', 'remove']
function show(j: Job): string {
	let id = j.run?.session,
		tab = id ? tabs.file().open.indexOf(id) : -1
	let link = id
		? `[${tab < 0 ? id + ' (closed)' : `tab ${tab + 1}`}](${settings.webUrl().replace(/\/$/, '')}/${id})`
		: 'none'
	let next = new Date(j.next).toLocaleString('en-GB', { timeZone: j.timezone })
	return `${j.id}. ${j.paused ? 'Paused' : scheduler.active(j) ? 'Running' : 'Waiting'} - ${j.prompt.split('\n')[0].slice(0, 100)}
${j.when} | Next: ${j.paused ? 'none' : next} | ${j.timezone}
Last run: ${link}${j.run?.result ? ` - ${j.run.result}` : ''}`
}
export const command: SlashCommand = {
	help: () => `/schedule lists jobs. /schedule add {when: "30m", prompt: "Check tests"}
/schedule show|pause|resume|remove ID. To change settings, remove and add again. Stop current work in its session.
Options: cwd (current), timezone (client IANA zone), model (default or model/alias). Completed runs close their tabs.
Times: 30m, hourly at :20, monday at 12:00, daily at 09:00, 09:00..19:00 every 1h. DST repeats run twice; missing minutes skip.
Active runs skip occurrences. Downtime catches up once. Interrupted work is not retried. Pause affects future runs only.`,
	complete(args) {
		if (/^add\s+\{\s*$/.test(args)) return scheduler.keys.map((key) => `${args}${key}: `)
		let model = /^(add\s+\{.*\bmodel:\s*)['"]?[^,'"}]*$/.exec(args)
		if (model)
			return ['default', 'openai', 'claude', ...models.known()]
				.map((m) => `${model[1]}'${m}'`)
				.filter((v) => v.startsWith(args))
		return operations
			.flatMap((op) =>
				['list', 'add'].includes(op) ? [op] : [op, ...scheduler.file().jobs.map((j) => `${op} ${j.id}`)],
			)
			.filter((value) => value.startsWith(args))
	},
	run(args, _answers, ctx) {
		let store = scheduler.file()
		if (!args || args === 'list') return { say: store.jobs.map(show).join('\n\n') || 'No scheduled jobs.' }
		let match = /^(show|add|pause|resume|remove)(?:\s+(\d+))?(?:\s+([\s\S]+))?$/.exec(args)
		if (!match) return { error: command.help!('') }
		let [, op, id, text] = match
		let j = store.jobs.find((job) => job.id === Number(id))
		if (op === 'add' ? !!id : !j)
			return { error: 'Use add without an ID; other operations require an existing job ID.' }
		if (op === 'add') {
			let patch = ason.parse(text ?? '{}')
			if (!patch || typeof patch !== 'object' || Array.isArray(patch))
				return { error: 'Settings must be an ASON object.' }
			let value = { cwd: ctx.cwd, timezone: clients.timezone(ctx.sessionId), model: 'default', ...patch }
			if (typeof value.cwd === 'string') value.cwd = commands.expand(value.cwd, ctx.cwd)
			let options = scheduler.options(value)
			let next = scheduleTime.next(scheduleTime.parse(options.when), clock.now(), options.timezone)
			store.jobs.push({ ...options, id: ++store.serial, paused: false, next })
			j = store.jobs.at(-1)!
		} else {
			if (text) return { error: `Usage: /schedule ${op} ID` }
			if (op === 'show') return { say: ason.stringify(j) }
			if (op === 'remove') {
				if (scheduler.active(j!)) return { error: 'Stop the active run in its session before removing this job.' }
				store.jobs = store.jobs.filter((job) => job !== j)
			} else {
				j!.paused = op === 'pause'
				if (!j!.paused) j!.next = scheduleTime.next(scheduleTime.parse(j!.when), clock.now(), j!.timezone)
			}
		}
		scheduler.save()
		return { say: op === 'remove' ? `Removed schedule ${id}.` : show(j!) }
	},
}
