// A session's blocks as its clients show them (tasks 4qh, v8y), built
// from history: what /go and /toggle find block ids in.
import { replay } from '../common/replay.ts'
import { transcript, type Item } from '../common/transcript.ts'
import { history } from './history.ts'

// Session `id`'s blocks with ids, in history order.
function of(id: string): Item[] {
	return replay.current(history.readSync(id)).flatMap((r, i) => transcript.recordItems(r, i)).filter((i) => /^\d+(\.\d+)?$/.test(i.key))
}

export const sessionBlocks = { of }
