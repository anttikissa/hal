// Context window sizes for known models.

const CONTEXT_WINDOWS: Record<string, number> = {
	'claude-opus-4-6': 200_000,
	'claude-sonnet-4-6': 200_000,
	'claude-opus-4-5': 200_000,
	'claude-sonnet-4-5': 200_000,
	'claude-sonnet-4-20250514': 200_000,
}

const DEFAULT_CONTEXT = 200_000

export function contextWindowForModel(modelId: string): number {
	for (const [prefix, size] of Object.entries(CONTEXT_WINDOWS)) {
		if (modelId.startsWith(prefix)) return size
	}
	return DEFAULT_CONTEXT
}
