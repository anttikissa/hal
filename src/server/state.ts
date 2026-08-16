import { chmodSync, mkdirSync, existsSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'

const HAL_DIR = process.env.HAL_DIR ?? resolve(import.meta.dir, '../..')
const STATE_DIR = process.env.HAL_STATE_DIR ?? (process.env.NODE_ENV === 'test' ? `${tmpdir()}/hal-test-state-${process.pid}` : `${HAL_DIR}/state`)
const IPC_DIR = `${STATE_DIR}/ipc`

function ensureDir(dir: string): void {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// State holds conversation transcripts, blobs and IPC files, so keep it readable only by its owner.
// 0700 on these two dirs is enough: other users cannot traverse into them whatever the files inside
// are chmodded to. chmodSync also tightens dirs created by older versions, and unlike mkdirSync's
// mode option it is not masked by umask.
function ensureStateDir(): void {
	ensureDir(STATE_DIR)
	ensureDir(IPC_DIR)
	chmodSync(STATE_DIR, 0o700)
	chmodSync(IPC_DIR, 0o700)
}

export { HAL_DIR, STATE_DIR, IPC_DIR, ensureDir, ensureStateDir }
