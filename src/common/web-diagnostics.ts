// Structural browser diagnostics only: never text, URLs or identifiers.
export const diagnosticKinds = ['start', 'error', 'rejection', 'pointer', 'click', 'settled', 'manual', 'visibility', 'pageshow', 'focus', 'connection', 'event', 'key', 'drift'] as const
export const diagnosticDetails = ['other', 'tabs', 'composer', 'card', 'joining', 'connected', 'disconnected', 'visible', 'hidden', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'DOMException', 'snapshot', 'state', 'inbox', 'meta', 'attached', 'models', 'warning', 'rejected', 'ack', 'go', 'turn-start', 'turn-end', 'turn-stats', 'stream', 'tool-output', 'tool-results', 'prompt', 'history', 'question', 'answer', 'command', 'output', 'divider', 'completions', 'notice', 'draft', 'auth', 'model-names', 'find-results', 'body', 'button', 'link', 'field', 'dialog'] as const
export type DiagnosticKind = typeof diagnosticKinds[number]
export type DiagnosticDetail = typeof diagnosticDetails[number]
export type Breadcrumb = { at: number; kind: DiagnosticKind; detail: DiagnosticDetail; line?: number; column?: number }
export const diagnosticNumbers = ['tab', 'renderedTab', 'tabs', 'cached', 'items', 'width', 'height', 'viewportHeight', 'viewportTop', 'scrollTop', 'lag', 'appHeight'] as const
export const diagnosticBooleans = ['live', 'modal', 'form', 'connected', 'visible', 'focused', 'standalone', 'composerFocused'] as const
export type DiagnosticContext = Partial<Record<typeof diagnosticNumbers[number], number> & Record<typeof diagnosticBooleans[number], boolean>>
export type BrowserReport = { page: string; version: string; at: number; context: DiagnosticContext; entries: Breadcrumb[] }
