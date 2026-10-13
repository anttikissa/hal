const newest = new Intl.Collator('en', { numeric: true })

function select(input: string, ids: string[]): string | undefined {
	let family = modelAliases.families[input] ?? input
	if (!/^[a-z]+$/.test(family)) return undefined
	let pattern = ['sol', 'astra', 'luna', 'terra'].includes(family)
		? new RegExp(`^(?:gpt-)?(\\d+(?:[.-]\\d+)*)-${family}$|^${family}-(\\d+(?:[.-]\\d+)*)$`, 'i')
		: new RegExp(`^(?:claude-)?${family}[-_](\\d+(?:[.-]\\d+)*)$`, 'i')
	let best: { id: string; version: string } | undefined
	for (let id of ids) {
		if (/[-_](?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(id)) continue
		let match = pattern.exec(id.split('/').at(-1)!)
		let version = (match?.[1] ?? match?.[2])?.replaceAll('-', '.')
		if (version && (!best || newest.compare(version, best.version) > 0)) best = { id, version }
	}
	return best?.id
}

export const modelAliases = {
	families: { openai: 'sol', gpt: 'sol', anthropic: 'opus', claude: 'opus' } as Record<string, string>,
	select,
}
