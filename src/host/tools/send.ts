// send: messages another session (task rj). The host, not the model,
// says who sent it: the calling session, by tab, id and name.
//
// `delivery` (task 760): soft-steer (default) reaches the recipient
// before its next request without interrupting work; emergency steers
// as a user message does; queue waits for its current turn to end. An
// idle recipient gets it as a turn of its own (prompts.submit). The
// result says which happened, including a message left waiting for the
// user because the recipient is paused, failed, blocked or closed. Only
// a steer wakes a closed session, reopening its tab so its work shows.
// Tasks: rqq, zbw.

import { existsSync } from 'fs'
import type { Sender } from '../../common/blocks.ts'
import { session } from '../../common/session.ts'
import { host } from '../host.ts'
import { paths } from '../paths.ts'
import { prompts } from '../prompts.ts'
import { status } from '../status.ts'
import { tabs } from '../tabs.ts'
import type { Tool, ToolContext } from '../tools.ts'

// Configuration: true puts the whole help in the system prompt; false
// lists only the summary under Other tools (HELP <TOOL> shows the rest).
const inPrompt = false
const summary = 'message to session'
const help = `## SEND

Send a message to another session, by tab number or session id. The message goes between !!START and !!END lines, literally: no quoting or escaping.
SEND /* <purpose> */ "<to>" { delivery? }?
!!START
<message>
!!END
	delivery?: "soft-steer" | "queue" | "steer"    default "soft-steer"
- soft-steer delivers at the next round without interrupting; queue waits for the current turn to end; steer starts or resumes the recipient and interrupts active work, except unsafe calls and background work.
- Use soft-steer for routine updates and steer for explicit continuation of a paused or failed session; ordinary sends stay pending while paused or failed.
- When a child asks you a question, answer with SEND.
::: if $session_interactive
- The purpose is one short plain-language sentence for the user: what the message says or asks, e.g. /* Ask tab 2 to rerun the tests */
:::`

const parameters = {
	type: 'object',
	properties: {
		to: { type: 'string' },
		text: { type: 'string' },
		description: { type: 'string' },
		delivery: { type: 'string', enum: ['soft-steer', 'queue', 'steer', 'emergency'] },
	},
	required: ['to', 'text'],
}

const syntax = {
	usage: ['SEND "<to>" { delivery? }?', '!!START', '<message>', '!!END'],
	positional: ['to', 'text'],
	block: 'text',
	aliases: { session: 'to', message: 'text' },
}

// The session a tab number or id names, if it exists.
function target(to: string): string | undefined {
	if (/^\d+$/.test(to)) return tabs.file().open[Number(to) - 1]
	return session.isId(to) && existsSync(`${paths.sessionDir(to)}/session.ason`) ? to : undefined
}

// What became of a message just submitted, for the sender.
function outcome(id: string, text: string, from: string, delivery: string): string {
	let to = tabs.label(id)
	let item = status.inboxOf(id).findLast((m) => m.from === from && m.text === text)
	if (!item) return `Sent to ${to}: it started a turn`
	let state = status.stateOf(id)
	if (tabs.closed(id))
		return `Waiting in ${to}: the user closed its tab; this message stays pending until it is reopened. If it should act now, SEND "${id}" again with { delivery: "steer" }: that reopens its tab and wakes it`
	let held = { paused: 'paused', error: 'failed' }[state.type as string]
	if (held)
		return `Waiting in ${to}: it is ${held}; this message stays pending. To resume it, SEND "${id}" "Continue your work and read pending messages" { delivery: "steer" }`
	if (state.type === 'blocked') return `Waiting in ${to}: it waits for the user (${state.reason}); it reads this after`
	if (item.delivery === 'after-turn') return `Queued in ${to}: it reads this after its current turn`
	return delivery === 'steer'
		? `Interrupted ${to}: it reads this now`
		: `Sent to ${to}: it reads this before its next request`
}

async function run(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
	let { to, text, description, delivery = 'soft-steer' } = input
	if (typeof to !== 'string' || !to.trim()) throw new Error('to must be a tab number or session id')
	if (typeof text !== 'string' || !text.trim()) throw new Error('text must be a non-empty string')
	if (description !== undefined && (typeof description !== 'string' || !description.trim()))
		throw new Error('description must be a non-empty sentence; the message was not sent')
	if (delivery === 'emergency') delivery = 'steer'
	if (delivery !== 'soft-steer' && delivery !== 'queue' && delivery !== 'steer')
		throw new Error('delivery must be soft-steer, queue or steer (emergency aliases steer)')
	let id = target(to.trim())
	if (!id) throw new Error(`no session ${to}`)
	if (id === ctx.sessionId) throw new Error('cannot send to this session itself')
	await (host.ready(id) ?? Promise.resolve())
	if (delivery === 'steer' && tabs.closed(id)) tabs.act({ type: 'tab-resume', sessionId: id })
	let sender: Sender = {
		from: ctx.sessionId,
		label: tabs.label(ctx.sessionId),
		...(description && { summary: description.replace(/\s+/g, ' ').trim() }),
	}
	if (delivery === 'soft-steer') sender.advisory = true
	let refused = prompts.submit(id, text, undefined, delivery, sender)
	if (refused) throw new Error(refused)
	return outcome(id, text, ctx.sessionId, delivery)
}

export const tool: Tool = { name: 'send', inPrompt, summary, help, parameters, syntax, run }
