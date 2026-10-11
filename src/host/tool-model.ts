import type { StreamEvent } from '../common/blocks.ts'
import type { HistoryRecord } from '../common/replay.ts'
import type { Reply } from './synthetic.ts'
import { nativeTool } from './native-tool.ts'
import { sessions } from './sessions.ts'

async function* call(cmd: string, sessionId: string): AsyncGenerator<StreamEvent> {
	yield nativeTool.arrived({ type: 'tool_call', id: `tool-${crypto.randomUUID()}`, name: 'tool', input: { cmd } }, { sessionId, cwd: sessions.open(sessionId).cwd, model: 'hal/tool' })
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
	welcome: 'Direct tool mode — no AI. Type BASH ls to run a tool, or HELP to explore. Commands execute as typed and can change files. Cook away.',
}
