// Scripted models run inside the host, no provider needed: hal/intro
// (intro.ts). Each answered form is durable in history; a model derives
// its next step from those records. A reply's paragraphs arrive with
// a typing pace (pauseMs); `pause` ends the turn paused with that reason,
// and `then` runs once the turn has ended (a command the reply starts).
import type { StreamEvent } from '../common/blocks.ts'
import type { Answers, Form } from '../common/forms.ts'
import type { HistoryRecord } from '../common/replay.ts'
import { intro } from './intro.ts'

export type Reply = { say?: string; ask?: Form; pause?: string; then?: () => void }
export type Synthetic = (records: HistoryRecord[], answers?: Answers, sessionId?: string) => Reply

function find(model: string): Synthetic | undefined {
	return model.startsWith('hal/') ? synthetic.models[model.slice(4)] : undefined
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

// A reply's text as a stream, like someone typing: word by word, a
// tenth of pauseMs apart, and paragraphs a pause apart. The turn
// streams meanwhile, so the prompt stays free.
async function* paced(say: string | undefined, signal: AbortSignal): AsyncGenerator<StreamEvent> {
	for (let [i, text] of (say?.split('\n\n') ?? []).entries()) {
		if (i) await sleep(synthetic.pauseMs())
		for (let [j, word] of text.split(/(?<=\s)/).entries()) {
			if (j) await sleep(synthetic.pauseMs() / 10)
			if (signal.aborted) return
			yield { type: 'text', text: i && !j ? `\n\n${word}` : word }
		}
	}
	yield { type: 'done', reason: 'end' }
}

export const synthetic = {
	models: { intro: (records, answers, id) => intro.run(records, answers, id) } as Record<string, Synthetic>,
	find,
	paced,
	pauseMs: (): number => 400,
}
