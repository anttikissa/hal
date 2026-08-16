type WriteOptions = {
	bypassExternalEditorLatch?: boolean
}

const state = {
	externalEditorOpen: false,
}

function setExternalEditorOpen(value: boolean): void {
	state.externalEditorOpen = value
}

function isExternalEditorOpen(): boolean {
	return state.externalEditorOpen
}


function write(text: string, opts: WriteOptions = {}): boolean {
	if (state.externalEditorOpen && !opts.bypassExternalEditorLatch) return false
	return process.stdout.write(text)
}

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => {
		process.stdout.write('', () => resolve())
	})
}

export const terminalOutput = { state, setExternalEditorOpen, isExternalEditorOpen, write, flush }
