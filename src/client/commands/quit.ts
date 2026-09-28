// /quit (Ctrl-C, caught by the emergency path): quits this client.

import { terminal } from '../terminal.ts'

export const command = { run: (): void => terminal.quit() }
