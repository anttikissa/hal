// Model selection. Config values are functions read at call time, so
// local.ts can replace them (see tasks/README.md).

import { settings } from '../common/settings.ts'

export const models = {
	// provider/model id used when a session has not chosen one:
	// config.ason's `model`.
	defaultModel(): string {
		return settings.model()
	},
}
