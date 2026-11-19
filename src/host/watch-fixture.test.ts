// Tests that write into a watched directory first wait here until the
// watcher can see the write.
import { unlinkSync, watch, writeFileSync } from 'fs'
import { join } from 'path'

// Waits until fs.watch reports writes in `dir`. On macOS, Bun's watchers
// share one FSEvents stream that starts some time after watch() returns,
// and a write made before then is never reported; under the parallel
// suite's load that window exceeded 2 s. Once a probe watcher of our own
// sees its event, every earlier watcher in this process is live too.
export async function watchLive(dir: string): Promise<void> {
	let probe = join(dir, '.watch-probe'),
		seen = false
	let watcher = watch(dir, { persistent: false }, (_event, name) => {
		if (name === '.watch-probe') seen = true
	})
	try {
		for (let i = 0; i < 500 && !seen; i++) {
			writeFileSync(probe, '')
			await Bun.sleep(20)
		}
		if (!seen) throw new Error(`watching ${dir} never reported a write`)
	} finally {
		watcher.close()
		unlinkSync(probe)
	}
}
