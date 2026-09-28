// /restart (Ctrl-R, caught by the emergency path): exits with the
// restart code, which ./run answers by starting again.

import { terminal } from '../terminal.ts'

export const command = { run: (): void => terminal.restart() }
