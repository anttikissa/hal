const newest = new Intl.Collator('en', { numeric: true })

function select(input: string, ids: string[]): string | undefined {
	let family = modelAliases.families[input] ?? input
	if (!/^[a-z]+$/.test(family)) return undefined
	let pattern = ['sol', 'astra', 'luna', 'terra'].includes(family)
		? new RegExp(`^(?:gpt-)?(\\d+(?:[.-]\\d+)*)-${family}$|^${family}-(\\d+(?:[.-]\\d+)*)$`, 'i')
		: new RegExp(`^(?:claude-)?${family}[-_]?[kmv]?(\\d+(?:[.-]\\d+)*)${['glm', 'qwen', 'kimi', 'deepseek', 'minimax'].includes(family) ? '(?:-(?<tier>(?:max|pro|plus|flash|mini|air)(?:-prime|-\\d{4})?|prime))?' : ''}$`, 'i')
	let best: { id: string; version: string; rank: number } | undefined
	for (let id of ids) {
		if (/[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(id)) continue
		let match = pattern.exec(id.split('/').at(-1)!)
		let version = (match?.[1] ?? match?.[2])?.replaceAll('-', '.')
		let rank = /^(max|pro)/.test(match?.groups?.tier ?? '') ? 0 : match?.groups?.tier === 'plus' ? 1 : /^(flash|mini|air)/.test(match?.groups?.tier ?? '') ? 3 : 2
		if (version && (!best || newest.compare(version, best.version) > 0 || (newest.compare(version, best.version) === 0 && (rank < best.rank || (rank === best.rank && /prime/.test(best.id) && !/prime/.test(id)))))) best = { id, version, rank }
	}
	return best?.id
}

export const modelAliases = {
	families: { openai: 'sol', gpt: 'sol', anthropic: 'opus', claude: 'opus' } as Record<string, string>,
	select,
}
