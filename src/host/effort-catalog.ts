// Verified gateway metadata survives restart, without serializing wire functions.
import { mkdirSync } from 'fs'
import { effort, type EffortCapability } from '../common/effort.ts'
import { liveFiles } from './live-file.ts'
import { paths } from './paths.ts'

function file(): string { return `${paths.stateDir()}/effort-catalog.ason` }
function read(): Record<string, EffortCapability> {
	let data = liveFiles.liveFile<Record<string, EffortCapability>>(effortCatalog.file(), {}, { watch: false })
	try {
		for (let [id, cap] of Object.entries(data)) {
			if (!cap || !Array.isArray(cap.levels) || !cap.levels.every((l) => effort.levels.includes(l)) || (cap.default !== undefined && !cap.levels.includes(cap.default))) throw new Error(`${effortCatalog.file()}: invalid effort capability for ${id}`)
		}
		return { ...data }
	} finally { liveFiles.close(data) }
}
function save(values: Record<string, EffortCapability>): void {
	mkdirSync(paths.stateDir(), { recursive: true })
	let data = liveFiles.liveFile<Record<string, EffortCapability>>(effortCatalog.file(), {}, { watch: false })
	try {
		for (let id of Object.keys(data)) if (!(id in values)) delete data[id]
		Object.assign(data, values)
		liveFiles.save(data)
	} finally { liveFiles.close(data) }
}
export const effortCatalog = { file, read, save }
