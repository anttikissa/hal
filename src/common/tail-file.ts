// Follows a file as it grows: its bytes from the start, then every
// append. The verbatim ASON test (task mw) imports it; cancelling the
// stream stops the follower.

function tailFile(path: string): ReadableStream<Uint8Array> {
	let proc = Bun.spawn(['tail', '-f', '-c', '+1', path], { stdout: 'pipe', stderr: 'ignore' })
	let reader = proc.stdout.getReader()
	return new ReadableStream({
		async pull(controller) {
			let { done, value } = await reader.read()
			if (done) controller.close()
			else controller.enqueue(value)
		},
		cancel() {
			proc.kill()
		},
	})
}

export const tails = { tailFile }
