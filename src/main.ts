// Composition root: the one explicit startup path. Other modules do no
// work on import; start() calls their init() functions in order.

function start(): void {
	console.log('hal2')
}

export const main = { start }

// Only ./run starts Hal; importing this file (tests, eval) does nothing.
if (import.meta.main) main.start()
