// Structural browser diagnostics only: never text, URLs or identifiers.
export const diagnosticKinds = ['start', 'error', 'rejection', 'pointer', 'click', 'settled', 'manual', 'visibility', 'pageshow', 'focus', 'connection', 'event', 'key', 'drift', 'pulled', 'scroll', 'pin', 'load', 'pointerup', 'pointercancel', 'disabled', 'send', 'outcome', 'longtask'] as const
export const diagnosticDetails = ['other', 'tabs', 'composer', 'card', 'joining', 'connected', 'disconnected', 'visible', 'hidden', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'DOMException', 'snapshot', 'state', 'inbox', 'meta', 'attached', 'models', 'settings', 'warning', 'rejected', 'ack', 'go', 'turn-start', 'turn-end', 'turn-stats', 'stream', 'tool-output', 'tool-results', 'prompt', 'history', 'question', 'answer', 'command', 'output', 'divider', 'completions', 'notice', 'draft', 'auth', 'model-names', 'find-results', 'body', 'button', 'link', 'field', 'dialog', 'selected', 'requested', 'ready', 'tail', 'built', 'encoded', 'parsed', 'applied', 'frame', 'send', 'steer', 'queue', 'run', 'save', 'pause', 'continue', 'nudge', 'attach', 'queue-edit', 'upload', 'client-command', 'submitted', 'refused', 'empty'] as const
export type DiagnosticKind = typeof diagnosticKinds[number]
export type DiagnosticDetail = typeof diagnosticDetails[number]
export const scrollCauses = ['other', 'sample', 'wheel', 'touchstart', 'touchend', 'key', 'find', 'press', 'release', 'drag', 'restore', 'force', 'resume', 'scroll', 'content', 'resize', 'shown', 'toggle', 'link'] as const
// from: the position Hal last saw before a pin change. delta, up: a
// wheel event's |deltaY| and direction.
export const scrollNumbers = ['top', 'height', 'client', 'gap', 'from', 'delta'] as const
export const scrollBooleans = ['pinned', 'held', 'intent', 'up'] as const
export type ScrollDiagnostic = Partial<Record<typeof scrollNumbers[number], number> & Record<typeof scrollBooleans[number], boolean>>
export type Breadcrumb = { at: number; kind: DiagnosticKind; detail: DiagnosticDetail; line?: number; column?: number; ms?: number; bytes?: number; tab?: number; cause?: typeof scrollCauses[number]; scroll?: ScrollDiagnostic }
// heap: the page's JS heap in MiB (Chrome only, coarse: web/memory.ts).
export const diagnosticNumbers = ['tab', 'renderedTab', 'tabs', 'cached', 'items', 'width', 'height', 'viewportHeight', 'viewportTop', 'scrollTop', 'lag', 'appHeight', 'heap', 'dropped'] as const
export const diagnosticBooleans = ['live', 'modal', 'form', 'connected', 'visible', 'focused', 'standalone', 'composerFocused'] as const
export type DiagnosticContext = Partial<Record<typeof diagnosticNumbers[number], number> & Record<typeof diagnosticBooleans[number], boolean>>
export type BrowserReport = { page: string; version: string; at: number; context: DiagnosticContext; entries: Breadcrumb[] }
