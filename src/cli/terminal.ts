// Terminal escape sequence constants and cleanup helpers.

export const KITTY_KBD_ON = '\x1b[>19u'
export const KITTY_KBD_OFF = '\x1b[<u'
export const BRACKETED_PASTE_ON = '\x1b[?2004h'
export const BRACKETED_PASTE_OFF = '\x1b[?2004l'
export const TERM_RESET = `${KITTY_KBD_OFF}${BRACKETED_PASTE_OFF}\x1b[?25h`

type Writable = { write(s: string): any }
type Listenable = { removeAllListeners(e: string): any; on(e: string, fn: (...args: any[]) => void): any }

/**
 * Disable terminal input modes immediately.
 * Writes TERM_RESET to stdout and replaces stdin data handler with a noop
 * to drain any buffered kitty keyboard protocol sequences.
 *
 * Must be called synchronously in quit/restart before any async work,
 * to prevent kitty sequences from leaking to the parent shell.
 */
export function disableTerminalInput(stdout: Writable, stdin: Listenable): void {
	stdout.write(TERM_RESET)
	stdin.removeAllListeners('data')
	stdin.on('data', () => {}) // keep stream flowing to drain buffered bytes
}

export const terminal = {
	KITTY_KBD_ON, KITTY_KBD_OFF, BRACKETED_PASTE_ON, BRACKETED_PASTE_OFF,
	TERM_RESET, disableTerminalInput,
}
