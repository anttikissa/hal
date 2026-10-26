// /logout: the opposite of /login. Removes provider accounts from this
// home's credentials file by the ids /status shows (a1, o3, g2). The
// provider is not told; an environment key can only be unset.

import { auth, type Kind } from '../auth.ts'
import type { SlashCommand } from '../commands.ts'
import { liveFiles } from '../live-file.ts'

const KINDS: Kind[] = ['anthropic', 'openai', 'opencode-go']

// Every account of every provider, by id.
function accounts() {
	return KINDS.flatMap((kind) => {
		let found
		try {
			found = auth.all(kind)
		} catch (e: any) {
			if (e?.message?.includes(`no ${kind} login`)) return []
			throw e
		}
		let stored: unknown[] = [found.data[kind] ?? []].flat()
		return found.list.map((account, i) => ({
			id: auth.slot(kind, i),
			kind,
			account,
			stored: stored.includes(account.entry),
		}))
	})
}

type Listed = ReturnType<typeof accounts>[number]

function label(a: Listed): string {
	return `${a.id} ${a.account.name}`
}

export const command: SlashCommand = {
	help: () =>
		'/logout <id...> removes provider accounts from the credentials file, by the ids /status shows (a1 Anthropic, o2 OpenAI, g1 OpenCode Go). Without ids it asks which. The remaining ids are renumbered. Accounts from environment variables are removed by unsetting the variable.',
	complete: (args) => {
		let done = args.split(/\s+/)
		let last = done.pop()!
		let prefix = done.map((w) => `${w} `).join('')
		return accounts()
			.filter((a) => a.id.startsWith(last) && !done.includes(a.id))
			.map((a) => ({ value: prefix + a.id, description: a.account.name }))
	},
	run(args, answers) {
		let all = accounts()
		let ids = args.split(/\s+/).filter(Boolean)
		if (!ids.length && answers?.account) ids = [answers.account.split(' ')[0]!]
		if (!ids.length) {
			if (!all.length) return { error: 'no provider accounts to log out of' }
			return {
				ask: {
					text: 'Log out of which account?',
					fields: [{ type: 'choice', name: 'account', options: all.map(label) }],
				},
			}
		}
		let unknown = ids.filter((id) => !all.some((a) => a.id === id))
		if (unknown.length)
			return { error: `${unknown.join(', ')}: no such account; accounts are ${all.map((a) => a.id).join(', ')}` }
		let chosen = all.filter((a) => ids.includes(a.id))
		let env = chosen.filter((a) => !a.stored)
		if (env.length) return { error: env.map((a) => `${a.id} comes from ${a.account.name}; unset it`).join('\n') }
		let data = auth.store()
		let gone = new Set(chosen.map((a) => a.account.entry))
		for (let kind of new Set(chosen.map((a) => a.kind))) {
			let left = [data[kind]].flat().filter((e) => !gone.has(e))
			if (left.length) data[kind] = left
			else delete data[kind]
			// Names like "account 3" shift: let sessions pick again.
			for (let map of [auth.state.chosen, auth.state.picked])
				for (let key of map.keys()) if (key.startsWith(`${kind} `)) map.delete(key)
		}
		liveFiles.save(data)
		return { say: `logged out of ${chosen.map(label).join(', ')}` }
	},
}
