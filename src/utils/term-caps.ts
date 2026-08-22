// Terminal capability detection.
//
// GNU screen (macOS still ships 4.00.03 from 2006) parses 24-bit SGR but
// throws the color away unless it was built with truecolor support: a
// `38;2;r;g;b` arrives at the outer terminal as a bare `\e[2m` (dim), which is
// why Hal renders as washed-out gray inside screen. It also has no
// back-color-erase, so `\e[K` clears to the default background instead of the
// active one, wiping our block and prompt backgrounds.
//
// Screen also swallows the kitty keyboard-protocol query, so that stays off too.
//
// detect() must run before colors.init(), because color escapes are baked at
// load time.

const config = {
	truecolor: true,
	bce: true,
	kittyKeyboard: true,
}

function detect(): void {
	// STY is set inside a screen session; TERM is `screen*` for its children.
	const inScreen = Boolean(process.env.STY) || (process.env.TERM ?? '').startsWith('screen')
	config.truecolor = !inScreen
	config.bce = !inScreen
	config.kittyKeyboard = !inScreen
}

export const termCaps = { config, detect }
