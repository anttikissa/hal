import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const argv = new Set(process.argv.slice(2))

export const headless = argv.has("--headless")

// -f: use a fresh temp state directory
export const fresh = argv.has("-f")
if (fresh) {
	const dir = mkdtempSync(join(tmpdir(), "hal-state-"))
	process.env.HAL_STATE_DIR = dir
}
