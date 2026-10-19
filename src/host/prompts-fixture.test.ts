// Shared helpers for the prompts tests: the texts of a provider message
// and a client's view of a session inbox.
import type { client } from './host-fixture.test.ts'

export const texts = (msg: any) => msg.blocks.map((b: any) => b.text)
export const inboxOf = (c: ReturnType<typeof client>, id: string) => c.views.get(id)!.inbox.map((m) => m.text)
