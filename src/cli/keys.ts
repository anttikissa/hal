// Key sequence constants for tab management.
// Each set contains both the legacy byte and the kitty keyboard protocol
// sequence (CSI u encoding) for the same logical key.

export const CTRL_T_KEYS = new Set(['\x14', '\x1b[116;5u'])
export const CTRL_W_KEYS = new Set(['\x17', '\x1b[119;5u'])
export const CTRL_F_KEYS = new Set(['\x06', '\x1b[102;5u'])

export const CTRL_DIGIT_KEYS: Record<string, number> = {
	'\x1b[49;5u': 1,
	'\x1b[50;5u': 2,
	'\x1b[51;5u': 3,
	'\x1b[52;5u': 4,
	'\x1b[53;5u': 5,
	'\x1b[54;5u': 6,
	'\x1b[55;5u': 7,
	'\x1b[56;5u': 8,
	'\x1b[57;5u': 9,
}

export const ALT_DIGIT_KEYS: Record<string, number> = {
	'\x1b1': 1,
	'\x1b2': 2,
	'\x1b3': 3,
	'\x1b4': 4,
	'\x1b5': 5,
	'\x1b6': 6,
	'\x1b7': 7,
	'\x1b8': 8,
	'\x1b9': 9,
	'\x1b[49;3u': 1,
	'\x1b[50;3u': 2,
	'\x1b[51;3u': 3,
	'\x1b[52;3u': 4,
	'\x1b[53;3u': 5,
	'\x1b[54;3u': 6,
	'\x1b[55;3u': 7,
	'\x1b[56;3u': 8,
	'\x1b[57;3u': 9,
}

// macOS Option+digit when terminal doesn't remap Option to Alt
export const OPT_DIGIT_KEYS: Record<string, number> = {
	'¡': 1,
	'™': 2,
	'£': 3,
	'¢': 4,
	'∞': 5,
	'§': 6,
	'¶': 7,
	'•': 8,
	'ª': 9,
}

export const CTRL_PREV_TAB = new Set(['\x10', '\x1b[112;5u'])
export const CTRL_NEXT_TAB = new Set(['\x0e', '\x1b[110;5u'])
