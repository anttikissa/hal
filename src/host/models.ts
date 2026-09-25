// Model selection. Config values are functions read at call time, so
// local.ts can replace them (see tasks/README.md).

export const models = {
	// provider/model id used when a session has not chosen one.
	defaultModel(): string {
		return 'anthropic/claude-opus-4-5'
	},
}
