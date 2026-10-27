// Host protocol commands on a session open on the connection: prompts,
// drafts, attachments, pausing, answers, history pages and completions
// (host.act hands them over once the session is known to be open).
import { type Command, type Event } from '../common/protocol.ts'
import { forms } from '../common/forms.ts'
import { rebaseRows } from '../common/rebase-rows.ts'
import { sendKeys } from '../common/send-keys.ts'
import { states } from '../common/states.ts'
import { blobs } from './blobs.ts'
import { commands } from './commands.ts'
import { drafts } from './drafts.ts'
import { history } from './history.ts'
import { host, type Client, type Outcome } from './host.ts'
import { models } from './models.ts'
import { pages, type Page } from './pages.ts'
import { prompts } from './prompts.ts'
import { queueEdits } from './queue-edits.ts'
import { rebasePlans } from './rebase-plans.ts'
import { serverLog } from './server-log.ts'
import { slash } from './slash.ts'
import { status } from './status.ts'
import { turns } from './turns.ts'
import { work } from './work.ts'
import { scheduler } from './scheduler.ts'

// Carries out a valid command on an open session: what it did (a
// promise if that takes slices), or undefined if it will answer later.
function act(client: Client, c: Command & { sessionId: string }): Outcome | Promise<Outcome> | undefined {
	let queueEdit = queueEdits.intercept(client, c)
	if (queueEdit) return queueEdit
	if (
		(c.type === 'submit' && c.interactive !== false) ||
		c.type === 'continue' ||
		c.type === 'answer' ||
		c.type === 'pause'
	)
		scheduler.takeover(c.sessionId)
	// Delivered-prompt edits wait for stopped work, then recheck dedup.
	// /edit undo drops the running turn anyway, so it pauses it first.
	let parsed = c.type === 'submit' ? commands.parse(c.text) : undefined
	if (
		parsed?.name === 'edit' &&
		parsed.args === 'undo' &&
		states.busy(status.stateOf(c.sessionId)) &&
		!forms.open(history.readSync(c.sessionId))
	)
		turns.stop(c.sessionId)
	let stopping =
		c.type === 'submit' &&
		(c.amend || parsed?.name === 'edit') &&
		status.stateOf(c.sessionId).type === 'paused' &&
		turns.state.running.get(c.sessionId)?.done
	if (stopping) {
		stopping.then(() => host.state.clients.has(client) && host.handle(client, c))
		return undefined
	}
	let refused: string | undefined
	if (c.type === 'close') {
		queueEdits.disconnect(client, c.sessionId)
		client.open.delete(c.sessionId)
		if (client.visible === c.sessionId) client.visible = undefined
		if (client.shown === c.sessionId) client.shown = undefined
	} else if (c.type === 'attach') {
		let stored =
			c.name !== undefined ? blobs.stage(c.name, c.mediaType, c.data) : blobs.store(c.sessionId, c.mediaType, c.data)
		serverLog.log(
			`${c.sessionId} upload ${c.mediaType} ${Math.round((c.data.length * 3) / 4 / 1024)} KB by ${serverLog.client(client.record)}`,
		)
		return {
			reply: {
				type: 'attached',
				sessionId: c.sessionId,
				command: c.id ?? '',
				blob: stored.blob,
				marker: stored.marker,
			},
		}
	} else if (c.type === 'rebase-error') slash.output(c.sessionId, c.text, true)
	else if (c.type === 'rebase-apply') return { reply: rebasePlans.answer(c) }
	else if (c.type === 'submit') {
		let unknown = commands.parse(c.text) ? [] : blobs.unknown(c.sessionId, c.text)
		if (unknown.length)
			client.deliver({
				type: 'warning',
				text: `${unknown.join(', ')} names no attachment of this session; sent as text`,
			})
		let delivery = sendKeys.parse(c.delivery) ?? (c.queue ? 'queue' : 'steer')
		if (c.amend && delivery !== 'queue' && c.edits !== undefined)
			refused = prompts.edit(c.sessionId, c.edits, c.text, c.id)
		else if (commands.parse(c.text)?.name === 'rebase')
			refused = slash.command(c.sessionId, c.text, commands.parse(c.text)!, c.id, undefined, (reply) => {
				if (reply.rebase)
					client.deliver({
						type: 'rebase-plan',
						sessionId: c.sessionId,
						snapshot: reply.rebase,
						todo: rebaseRows.render(c.sessionId, reply.rebase),
					})
			})
		else refused = prompts.submit(c.sessionId, c.text, c.id, delivery, { interactive: c.interactive ?? true })
		if (refused === undefined && !c.aside) prompts.sent(c.sessionId, c.text, c.id, c.base)
	} else if (c.type === 'draft') {
		let changed = drafts.set(c.sessionId, c.text, c.base, c.id)
		if (changed) prompts.draft(c.sessionId, changed, c.id)
		else
			return {
				reply: {
					type: 'draft',
					sessionId: c.sessionId,
					draft: drafts.get(c.sessionId),
					...(c.id !== undefined ? { command: c.id } : {}),
				},
			}
	} else if (c.type === 'continue') refused = prompts.resume(c.sessionId)
	else if (c.type === 'pause')
		refused = status.stateOf(c.sessionId).type === 'paused' ? undefined : work.pause(c.sessionId)
	else if (c.type === 'answer') refused = prompts.reply(c.sessionId, c.question, c.answers)
	else if (c.type === 'models')
		void slash.models(c.sessionId).then((e) => host.state.clients.has(client) && client.deliver(e))
	else if (c.type === 'paste-text') return { reply: blobs.pasteText(c.sessionId, c.name) }
	else if (c.type === 'history') {
		let answer = (page: Page): Outcome => {
			let ids = [...new Set(page.records.flatMap((r) => (r.type === 'assistant' && r.model ? [r.model] : [])))]
			let names = models.nameEvent(ids)
			if (names) client.deliver(names)
			let reply: Event = { type: 'history', sessionId: c.sessionId, before: c.before, records: page.records }
			if (page.start > 0 && !page.records.some((r) => r.type === 'reset')) reply.older = page.start // nothing before a /clear (vh)
			return { reply }
		}
		let page = pages.slices(pages.pageSteps(c.sessionId, c.before))
		return page instanceof Promise ? page.then(answer) : answer(page)
	} else if (c.type === 'complete')
		client.deliver({
			type: 'completions',
			sessionId: c.sessionId,
			text: c.text,
			...commands.suggestions(c.text, slash.context(c.sessionId)),
		})
	return refused === undefined ? {} : { refused }
}

export const sessionCommands = { act }
