// /plugin-sync (task b81): open or focus this terminal's plugin review.
import type { SlashCommand } from '../commands.ts'

export const command: SlashCommand = {
	help: () =>
		"/plugin-sync: review portable plugins that differ between this remote terminal's home and the host. Each differing file offers Use client version, Use server version or Keep separate; Escape defers and writes nothing.",
	run: (_args, _answers, ctx) =>
		(require('../plugin-sync-session.ts') as typeof import('../plugin-sync-session.ts')).pluginSyncSession.open(
			ctx.sessionId,
			ctx.cwd,
		),
}
