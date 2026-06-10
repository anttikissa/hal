import { config } from './config.ts'
import { models } from './models.ts'
import { HAL_DIR } from './state.ts'

function formatModelRefreshMessage(changes: string[], modelCount?: number): string {
	if (changes.length === 0) return `Fetched recent data from models.dev (${modelCount ?? 0} models)`
	const shown = changes.slice(0, 8)
	const more = changes.length > shown.length ? ` (+${changes.length - shown.length} more)` : ''
	return `[models.dev] fetched model metadata; relevant changes: ${shown.join('; ')}${more}`
}

function buildAliasUpdateSuggestionText(updates: Array<{ aliases: string[]; oldModel: string; newModel: string }>, cwd: string): string {
	const lines = [
		'It looks like some of your model aliases got updates:',
		'',
		...updates.map((update) => `- **${update.aliases.join('**, **')}**: **${update.oldModel}** → **${update.newModel}**`),
	]
	const configuredDefault = config.data.models?.default
	if (typeof configuredDefault === 'string') {
		lines.push('', `config.ason sets the default model to **${configuredDefault}**, which currently maps to **${models.resolveModel(configuredDefault)}**.`)
	}
	lines.push('')
	if (cwd === HAL_DIR) lines.push('Would you like me to update those aliases in ~/.hal?')
	else lines.push('Would you like me to spawn a subagent in ~/.hal and update those aliases?')
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
	buildAliasUpdateSuggestionText,
	checkModels,
}
