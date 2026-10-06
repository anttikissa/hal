// /toggle, /expand and /collapse (tasks ghs, v8y), run by the model or
// another client: the host resolves the target against history, tells
// the clients following the session to apply it to their own fold
// state, and names the blocks it matched with their model and effort,
// so the model can narrow a request to a list. Typed by the user, the
// clients run them themselves, unrecorded.
import { toggle, type Mode } from '../../common/toggle.ts'
import { titles } from '../../common/titles.ts'
import type { Item } from '../../common/transcript.ts'
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { sessionBlocks } from '../session-blocks.ts'

const syntax = 'Targets: 24 or #t24 (one block), 10-24 (a range), t14,r2-9 (a list), t* (every tool block); kinds t tool, r thinking, a assistant, u user, m message, s system, q question (au10-40: user and assistant blocks in 10-40). Ranges and * leave user and assistant blocks alone unless named. Empty: the latest tool block.'
const help: Record<Mode, string> = {
	toggle: '/toggle [target] expands or collapses blocks: one named block flips; more expand when more than half are collapsed, else collapse.',
	expand: '/expand [target] expands blocks.',
	collapse: '/collapse [target] collapses blocks.',
}
const done: Record<Mode, string> = { toggle: 'Toggled', expand: 'Expanded', collapse: 'Collapsed' }

// 'r12 (opus-5-5, xhigh)': a block id, with its model and effort when
// history records them.
function label(i: Item): string {
	let by = i as { model?: string; effort?: string }
	let tags = [by.model?.split('/').pop()!.replace(/^claude-/, ''), by.effort].filter(Boolean)
	return titles.blockId(i) + (tags.length ? ` (${tags.join(', ')})` : '')
}

function folding(mode: Mode): SlashCommand {
	return {
		help: () => `${help[mode]} ${syntax}`,
		run(args, _answers, ctx) {
			let target = toggle.parse(args)
			if (typeof target === 'string') return { error: target }
			let found = toggle.resolve(sessionBlocks.of(ctx.sessionId), target, mode)
			if (typeof found === 'string') return { error: found }
			host.broadcast(ctx.sessionId, { type: 'toggle', sessionId: ctx.sessionId, target: args.trim(), ...(mode !== 'toggle' && { mode }) })
			return { result: `${done[mode]} ${toggle.noun(found)}${found.length > 1 ? ':' : ''} ${found.map(label).join(', ')}` }
		},
	}
}

export const command = folding('toggle')
export const toggleCommands = { folding, label }
