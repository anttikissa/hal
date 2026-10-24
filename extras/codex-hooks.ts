// Opt-in Codex command hooks and local package hooks (task sey).
import type { Plugin } from '../src/host/plugins.ts'
import { install } from './command-hooks.ts'
import type { Options } from './hook-sources.ts'

export default (plugin: Plugin, options: Options) => install(plugin, 'codex', options)
