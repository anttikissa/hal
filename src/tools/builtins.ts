// Built-in tool bootstrap.
//
// Importing this module is cheap: it only wires module references together.
// Registration happens in init(), so startup order stays explicit.

import { bash } from './bash.ts'
import { read } from './read.ts'
import { readBlobTool } from './read_blob.ts'
import { grep } from './grep.ts'
import { glob } from './glob.ts'
import { write } from './write.ts'
import { evalTool } from './eval.ts'
import { send } from './send.ts'
import { google } from './google.ts'
import { readUrl } from './read_url.ts'
import { analyzeHistory } from './analyze_history.ts'
import { spawnAgent } from './spawn_agent.ts'

const state = {
	initialized: false,
}

function init(): void {
	if (state.initialized) return
	state.initialized = true

	bash.init()
	read.init()
	readBlobTool.init()
	grep.init()
	glob.init()
	write.init()
	evalTool.init()
	send.init()
	google.init()
	readUrl.init()
	analyzeHistory.init()
	spawnAgent.init()
}

export const builtins = { state, init }
