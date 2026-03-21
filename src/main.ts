import { createInterface } from "readline"

const RESTART_CODE = 100

console.log("Hello, this is Hal.")

const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
	prompt: "> ",
})

rl.prompt()

rl.on("line", (line) => {
	console.log(`You said: ${line}`)
	rl.prompt()
})

rl.on("close", () => {
	process.exit(0)
})

if (process.stdin.isTTY) {
	process.stdin.on("keypress", (_ch: string, key: any) => {
		if (key?.ctrl && key.name === "r") {
			process.exit(RESTART_CODE)
		}
	})
} else {
	const origEmit = process.stdin.emit.bind(process.stdin)
	process.stdin.emit = function (event: string, ...args: any[]) {
		if (event === "data") {
			const data = args[0] as Buffer
			for (const byte of data) {
				if (byte === 0x12) {
					process.exit(RESTART_CODE)
				}
			}
		}
		return origEmit(event, ...args)
	}
}
