// /help: every command by category with its key, one command in detail,
// or a topic. Client-only commands are listed too (common/commands/list.ts).
// Tasks: et, x0, 18n.

import { commandList } from '../../common/commands/list.ts'
import { commands, type SlashCommand } from '../commands.ts'

const topics: Record<string, string> = {
	security: `By default, Hal asks before it runs a command that may destroy work or leak secrets. A leaked secret is sent to the model provider and stored in plaintext in session files.

Hal asks about:
  rm -rf outside /tmp
  git reset --hard, clean, stash drop/clear, push --force, checkout/restore of files
  Reading secret files (READ refuses them)
  ps -E, ps e, /proc/*/environ (env variables)

Secret files: .env*, .ssh/, .aws/, .gnupg/, secrets/, credentials*, auth.ason, private keys (*.pem, *.key, *.p12, *.pfx), crypto wallets. Public keys (*.pub) and .env.example are not secret.

Settings (/config security):
  best-effort: The default. Catches mistakes, not a determined attacker, such as a man-in-the-middle at the provider.
  yolo: No security whatsoever. Recommended only in a sandbox with no leakable secrets.`,
}

export const command: SlashCommand = {
	help: () => '/help lists every command by category.\n/help <name> shows one command or topic in detail.',
	complete: (args) =>
		[...commandList.all().map((c) => c.name), ...Object.keys(topics)].filter((n) => n.startsWith(args)),
	run(args) {
		let all = commandList.all().filter((c) => !c.hidden)
		if (args) {
			let [name = '', ...rest] = args.replace(/^\//, '').split(/\s+/)
			let info = commandList.byName(name)
			if (!info) return topics[name] ? { say: topics[name] } : { error: `no command or topic ${name}` }
			let text = commands.all().get(name)?.help?.(rest.join(' ')) ?? info.description
			if (['login', 'quit', 'suspend', 'budget'].includes(name))
				text += '\n\nAgents: unavailable through the command tool.'
			if (name === 'send' || name === 'queue') text += '\n\nAgents: use the send tool instead.'
			return { say: text }
		}
		let width = Math.max(...all.map((c) => c.name.length)) + 1
		let labels = (c: (typeof all)[number]) =>
			commandList
				.bindings(c)
				.map((b) => b.key)
				.join(' / ')
		let keys = Math.max(...all.map((c) => labels(c).length))
		let categories = [...new Set(all.map((c) => c.category))].sort()
		let lines = categories.flatMap((category) => [
			`${category}:`,
			...all
				.filter((c) => c.category === category)
				.map((c) => `  ${`/${c.name}`.padEnd(width + 2)}${labels(c).padEnd(keys + 2)}${c.description}`),
		])
		return { say: [...lines, '', `Topics: ${Object.keys(topics).join(', ')} (/help <topic>)`].join('\n') }
	},
}
