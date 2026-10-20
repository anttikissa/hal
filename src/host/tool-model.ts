// hal/tool: a scripted model that runs the tool calls the user types, so
// a human can try Hal's tools and see results as a model would. The
// commands run on the real machine.
import type { StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { Reply } from './synthetic.ts'
import { nativeTool } from './native-tool.ts'
import { sessions } from './sessions.ts'

async function* call(cmd: string, sessionId: string): AsyncGenerator<StreamEvent> {
	yield* nativeTool.expand(
		{ type: 'tool_call', id: `tool-${crypto.randomUUID()}`, name: 'tool', input: { cmd } },
		{ sessionId, cwd: sessions.open(sessionId).cwd, model: 'hal/tool' },
	)
	yield { type: 'done', reason: 'tool_use' }
}

function run(records: HistoryRecord[], sessionId: string): Reply {
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'assistant' && r.block.type === 'tool_call') return {}
		if (r.type !== 'user' || r.blocks.some((b) => b.type === 'tool_result')) continue
		let cmd = r.blocks
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join('\n')
		if (cmd) return { stream: toolModel.call(cmd, sessionId) }
	}
	return { say: toolModel.welcome }
}

export const toolModel = {
	run,
	call,
	welcome: `Welcome. This is the HAL 9001 Tool Protocol Server.

The Tool Protocol is a happy mishmash of early Internet protocols (think SMTP, NNTP, IRC), JS literals, and /* comments */, plus heredoc-style input for the EDIT tool.

Write tool calls here and I will execute them, showing results exactly like a model would see them.

**WARNING - this is not a simulator**: commands run on your actual machine. Be careful with BASH and EDIT.

\`\`\`
BASH /* Look for entry point */ "ls -l src | grep main"
READ README.md:1-5
INSPECT { scope: 'self', fields: 'tab, id, name, state' }
\`\`\`

EDIT is the Swiss Army knife of edit operations; models love it. \`HELP edit\` for the gory details.

\`\`\`
EDIT file.ts write
!!NEW
console.log('Hello world!')
!!END
\`\`\`

Multiple tool calls per message run in parallel if safe. Tools like BASH, EDIT, or COMMAND run serially.

Hal is tolerant in what it receives and strict in what it sends. Officially, arguments use "strings", { objects }, and /* comments */, but unambiguous variations are tolerated. Like, you don't have to capitalize tool names.

Type \`HELP\` for more info. Help texts are terse by design: they’re for models, not humans. Sorry not sorry.`,
}
