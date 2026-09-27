/// <reference lib="dom" />
// The browser client's entry point: host/web.ts bundles this file (and
// what it imports) into index.html. Runs in the browser only;
// importing it elsewhere does nothing.

import { render } from '@solidjs/web'
import { App } from './components/App.tsx'

if (typeof document !== 'undefined') render(() => <App />, document.body)
