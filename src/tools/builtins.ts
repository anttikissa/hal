// Built-in tool bootstrap.
//
// Importing this module is cheap: it only wires module references together.
// Registration happens in init(), so startup order stays explicit.

import './bash.ts'
import './read.ts'
import './read_blob.ts'
import './grep.ts'
import './glob.ts'
import './write.ts'
import './eval.ts'
import './send.ts'
import './google.ts'
import './read_url.ts'
import './analyze_history.ts'
import './spawn_agent.ts'

const state = {
	initialized: false,
}

function init(): void {
	if (state.initialized) return
	state.initialized = true
}

export const builtins = { state, init }
