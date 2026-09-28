// /redraw: repaints everything, whatever has the keys.

import { terminal } from '../terminal.ts'

export const command = { run: (): void => terminal.redraw() }
