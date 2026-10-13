import type { StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { Reply } from './synthetic.ts'
import { nativeTool } from './native-tool.ts'
import { sessions } from './sessions.ts'

async function* call(cmd: string, sessionId: string): AsyncGenerator<StreamEvent> {
	yield* nativeTool.expand({ type: 'tool_call', id: `tool-${crypto.randomUUID()}`, name: 'tool', input: { cmd } }, { sessionId, cwd: sessions.open(sessionId).cwd, model: 'hal/tool' })
	yield { type: 'done', reason: 'tool_use' }
}

function run(records: HistoryRecord[], sessionId: string): Reply {
	for (let i = records.length - 1; i >= 0; i--) {
		let r = records[i]!
		if (r.type === 'assistant' && r.block.type === 'tool_call') return {}
		if (r.type !== 'user' || r.blocks.some((b) => b.type === 'tool_result')) continue
		let cmd = r.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
		if (cmd) return { stream: toolModel.call(cmd, sessionId) }
	}
	return { say: toolModel.welcome }
}

export const toolModel = {
	run,
	call,
	welcome: `Welcome. This is the HAL 9001 Tool Protocol Server.

The Tool Protocol is a happy mishmash of early Internet protocols (think SMTP, NNTP and IRC), JS literals, and /* comments */.

Write tool calls and I will execute them. Commands will run on your machine and change your files. Example:

\`\`\`
BASH /* Look for entry point */ "ls -l src | grep main"
READ README.md:1-5
INSPECT { scope: 'self', fields: 'tab, id, name, state' }
\`\`\`

Hal is tolerant in what it receives and strict in what it sends. Officially, tools only accept "strings", { objects }, and /* comments */, but reasonable variations are accepted when they can be unambiguously understood.

Type HELP for more info.`,
}
