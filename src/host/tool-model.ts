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
	welcome: `This is HAL 9001 Tool Protocol Server.

The Tool Protocol is a happy mishmash of early Internet protocols (think SMTP, NNTP and IRC), JavaScript-compatible literals, and C-style comments.

Write tool calls here and I will execute them as if a model had issued them. No AI is involved. Commands can change files.

\`\`\`
BASH "echo $(ls | wc -l) files here"
READ README.md
\`\`\`

String literals and JavaScript objects can span multiple lines:

\`\`\`
BASH "for x in 1 2 3
do
  sleep 1; echo $x
done"

INSPECT {
  scope: 'self',
  fields: 'tab,id,name,state'
}
\`\`\`

EDIT takes multiple lines, too. This example replaces line 1. READ the file first, then replace HASH below with the version it gives you:

\`\`\`
EDIT README.md@HASH {
  range: '1-1',
  lines: ['# Whee!']
}
\`\`\`

In the spirit of Postel's law, Hal is tolerant in what it receives and strict in what it sends. Models sometimes invent tool syntax off the top of their heads, so I accept unambiguous variations while keeping validation and file-safety checks intact:

\`\`\`
BASH /* This is OK */ ls
bash "ls" /* This is OK, too; for ls -l, quote the command */
bash ls -l // Not OK: after the command, use an options object
BASH { cmd: 'ls' } // Yes, even this is OK
\`\`\`

Type HELP for the directory, or HELP BASH for a tool's syntax.

Ready when you are.`,
}
