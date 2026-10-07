// /plugin-sync (task b81): open or focus this terminal's plugin review.
import type { SlashCommand } from '../commands.ts'
import { pluginSyncSession } from '../plugin-sync-session.ts'

export const command: SlashCommand = {
	help: () => '/plugin-sync: review portable plugins that differ between this remote terminal\'s home and the host. Each differing file offers Use client version, Use server version or Keep separate; Escape defers and writes nothing.',
	run: (_args, _answers, ctx) => pluginSyncSession.open(ctx.sessionId, ctx.cwd),
}
