// /suspend (Ctrl-Z, caught by the emergency path): stops this client
// like a shell job.

import { terminal } from '../terminal.ts'

export const command = { run: (): void => terminal.suspend() }
