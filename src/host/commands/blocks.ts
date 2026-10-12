// /blocks (task hyt): show or set how kinds of blocks start in this
// session, over each client's blockVerbosity* settings. The overrides
// are session metadata, synced to every client.
import { card, type Kind, type Verbosity } from '../../common/card.ts'
import type { SessionMeta } from '../../common/session.ts'
import type { SlashCommand } from '../commands.ts'
import { host } from '../host.ts'
import { liveFiles } from '../live-file.ts'
import { sessions } from '../sessions.ts'

const usage = '/blocks [<kind> short|glimpse|long|default | reset]'

// 'tool long (this session), thinking short, …': each kind as it starts here.
function describe(blocks: SessionMeta['blocks']): string {
	return `Blocks: ${card.kinds.map((k) => `${k} ${card.verbosity(k, blocks)}${blocks?.[k] ? ' (this session)' : ''}`).join(', ')}`
}

export const command: SlashCommand = {
	help: () => `${usage}: show or set how blocks of a kind start in this session. short is the title row, glimpse a few rows more, long everything; default follows config.ason (blockVerbosity* in /config), reset drops every override. Kinds: ${card.kinds.join(', ')}. Ctrl-O steps one block.`,
	complete(args) {
		let [kind = '', value] = args.split(/\s+/)
		if (value === undefined) return [...card.kinds, 'reset'].filter((k) => k.startsWith(kind))
		return card.kinds.includes(kind as Kind) ? [...card.levels, 'default'].filter((v) => v.startsWith(value)).map((v) => `${kind} ${v}`) : []
	},
	run(args, _answers, ctx) {
		let meta = sessions.open(ctx.sessionId)
		let [kind, value, ...rest] = args.trim().split(/\s+/).filter(Boolean)
		if (!kind) return { say: describe(meta.blocks) }
		let next: NonNullable<SessionMeta['blocks']> = { ...meta.blocks }
		if (kind === 'reset' && !value) next = {}
		else if (!card.kinds.includes(kind as Kind) || rest.length || !value || ![...card.levels, 'default'].includes(value)) return { error: `usage: ${usage}` }
		else if (value === 'default') delete next[kind as Kind]
		else next[kind as Kind] = value as Verbosity
		if (Object.keys(next).length) meta.blocks = next
		else delete meta.blocks
		liveFiles.save(meta)
		host.broadcast(ctx.sessionId, { type: 'meta', sessionId: ctx.sessionId, meta: { ...meta } })
		return { say: describe(meta.blocks) }
	},
}
