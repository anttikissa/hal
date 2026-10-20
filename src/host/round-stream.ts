// One provider round of a running turn: the request built from the
// session's system prompt, history and native tool, and its stream with
// each native tool call expanded into Hal's tool calls.
import type { StreamEvent } from '../common/blocks.ts'
import { blobs } from './blobs.ts'
import { clock } from './clock.ts'
import { historyInput } from './history-input.ts'
import { models } from './models.ts'
import { nativeTool } from './native-tool.ts'
import { promptCache } from './prompt-cache.ts'
import { sessions } from './sessions.ts'
import { turns } from './turns.ts'
import { bash } from './tools/bash.ts'

async function* stream(
	id: string,
	model: string,
	running: { effort?: string },
	signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
	let { system, cacheId } = promptCache.prepare(id, {
		cwd: sessions.open(id).cwd,
		model: models.qualified(model, running.effort),
		now: clock.now(),
		sessionId: id,
	})
	let defs = [nativeTool.def()]
	let messages = await historyInput.messages(id, {
		overhead: system.length + JSON.stringify(defs).length,
		window: models.contextWindow(model),
		model,
	})
	if (signal.aborted) return
	for await (let event of turns.stream(
		model,
		{
			system,
			effort: running.effort,
			messages,
			tools: defs,
			image: (blob, maxEdge) => blobs.base64(id, blob, maxEdge),
			sessionId: id,
			cacheId,
		},
		signal,
	)) {
		if (signal.aborted) return
		if (event.type !== 'tool_call') {
			yield event
			continue
		}
		for (let call of nativeTool.expand({ ...event }, { cwd: sessions.open(id).cwd, sessionId: id, model })) {
			if (call.name === 'bash' && typeof call.input.command === 'string')
				call = {
					...call,
					input: { ...call.input, command: bash.withoutCd(call.input.command, sessions.open(id).cwd) },
				}
			yield { ...call, type: 'tool_call' }
		}
	}
}

export const roundStream = { stream }
