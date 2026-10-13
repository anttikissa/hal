// Scripted models run inside the host, no provider needed: hal/intro
// (intro.ts), and hal/plugin-sync (plugin-sync-session.ts). Each answered form is durable in history; a model derives
// its next step from those records. A reply's paragraphs arrive with
// a typing pace (pauseMs); `pause` ends the turn paused with that reason,
// and `after` runs once the turn has ended (a command the reply starts).
// `stream` replaces the paced text with raw events, tool calls included;
// the turn runs those and asks the model again, as with a provider.
// Tasks: vc, b81.
import type { StreamEvent } from '../common/blocks.ts'
import type { Answers, Form } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'

export type Reply = { say?: string; stream?: AsyncGenerator<StreamEvent>; ask?: Form; pause?: string; after?: () => void }
export type Synthetic = (records: HistoryRecord[], answers?: Answers, sessionId?: string) => Reply

function find(model: string): Synthetic | undefined {
	let name = model.startsWith('hal/') ? model.slice(4) : ''
	return Object.hasOwn(synthetic.models, name) ? synthetic.models[name] : undefined
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// A reply's text as a stream, like someone typing: word by word, a
// tenth of pauseMs apart, and paragraphs a pause apart. The turn
// streams meanwhile, so the prompt stays free.
async function* paced(say: string | undefined, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	for (let [i, text] of (say?.split('\n\n') ?? []).entries()) {
		if (i) await sleep(synthetic.pauseMs)
		for (let [j, word] of text.split(/(?<=\s)/).entries()) {
			if (j) await sleep(synthetic.pauseMs / 10)
			if (signal.aborted) return
			yield { type: 'text', text: i && !j ? `\n\n${word}` : word }
		}
	}
	yield { type: 'done', reason: 'end' }
}

export const synthetic = {
	models: {
		tool: (records, _answers, id) => (require('./tool-model.ts') as typeof import('./tool-model.ts')).toolModel.run(records, id!),
		intro: (records, answers, id) => (require('./intro.ts') as typeof import('./intro.ts')).intro.run(records, answers, id),
		'scroll-test': (records) => (require('./scroll-test.ts') as typeof import('./scroll-test.ts')).scrollTest.run(records),
		'queue-test': (records) => (require('./queue-test.ts') as typeof import('./queue-test.ts')).queueTest.run(records),
		'plugin-sync': (_records, answers, id) => (require('./plugin-sync-session.ts') as typeof import('./plugin-sync-session.ts')).pluginSyncSession.run(answers, id!),
	} as Record<string, Synthetic>,
	find,
	paced,
	pauseMs: 400,
}
