// Simple mtime-based file read cache.
// Avoids re-reading unchanged files (AGENTS.md, config, etc.) on every
// agent loop iteration. Checks mtime on each get — if unchanged, returns
// cached content. If file was modified or deleted, re-reads or evicts.

import { readFileSync, statSync } from 'fs'

interface CacheEntry {
	content: string
	mtimeMs: number
}

const cache = new Map<string, CacheEntry>()

/** Read file with caching. Returns null if file doesn't exist or can't be read. */
function read(path: string): string | null {
	try {
		const st = statSync(path)
		const cached = cache.get(path)
		// Cache hit: mtime unchanged, return cached content
		if (cached && cached.mtimeMs === st.mtimeMs) return cached.content
		// Cache miss or stale: re-read
		const content = readFileSync(path, 'utf-8')
		cache.set(path, { content, mtimeMs: st.mtimeMs })
		return content
	} catch {
		cache.delete(path)
		return null
	}
}

/** Manually evict a path from the cache. */
function evict(path: string): void {
	cache.delete(path)
}

/** Clear the entire cache. */
function clear(): void {
	cache.clear()
}

export const fileCache = { read, evict, clear }
