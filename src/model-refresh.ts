import { config } from './config.ts'
import { models } from './models.ts'

function formatModelRefreshMessage(changes: string[], modelCount?: number): string {
	if (changes.length === 0) return `Fetched recent data from models.dev (${modelCount ?? 0} models)`
	const shown = changes.slice(0, 8)
	const more = changes.length > shown.length ? ` (+${changes.length - shown.length} more)` : ''
	return `[models.dev] fetched model metadata; relevant changes: ${shown.join('; ')}${more}`
}


function buildNewModelDiscoveryText(discoveries: Array<{ provider: string; model: string; context: number }>, updates: Array<{ aliases: string[]; oldModel: string; newModel: string }> = []): string {
	const configured = discoveries.filter((item) => models.aliasesForModel(`${item.provider.toLowerCase()}/${item.model}`).length > 0)
	const additions = discoveries.filter((item) => {
		const fullId = `${item.provider.toLowerCase()}/${item.model}`
		return !configured.includes(item) && !updates.some((update) => update.newModel === fullId)
	})
	const line = (item: typeof discoveries[number]) => {
		const aliases = models.aliasesForModel(`${item.provider.toLowerCase()}/${item.model}`)
		const prefix = aliases.length ? `\`${aliases.join('`, `')}\` — ` : ''
		return `- ${prefix}${item.provider} ${item.model} (${models.formatTokenCount(item.context)} context)`
	}
	const lines = ['Model updates available through your configured accounts.']
	if (updates.length) lines.push('', 'Recommended updates:', ...updates.map((update) => `- change \`${update.aliases.join('`, `')}\`: ${update.oldModel} → ${update.newModel}`))
	if (configured.length) lines.push('', 'Already configured:', ...configured.map(line))
	if (additions.length) lines.push('', 'Recommended things to do:', ...additions.map((item) => `- add ${item.provider} ${item.model} to the model picker`))
	const configuredDefault = config.data.models?.default
	if (typeof configuredDefault === 'string') lines.push('', `Your default model is \`${configuredDefault}\` (config.ason), which resolves to ${models.resolveModel(configuredDefault)}.`)
	lines.push('', updates.length || additions.length ? 'Say “yes” to apply these updates.' : 'No update is needed.')
	return lines.join('\n')
}

async function checkModels(): Promise<{ result: Awaited<ReturnType<typeof models.refreshModels>>; message: string }> {
	const result = await models.refreshModels()
	return {
		result,
		message: modelRefresh.formatModelRefreshMessage(result.changes, result.modelCount),
	}
}

export const modelRefresh = {
	formatModelRefreshMessage,
	buildNewModelDiscoveryText,
	checkModels,
}
