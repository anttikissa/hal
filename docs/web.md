# Web / SolidJS 2

Read before editing web code. Solid 1 and React patterns are often wrong for our
prerelease Solid 2. Use the installed `solid-js/CHEATSHEET.md` as the API source
of truth; re-read it after upgrades.

## Stack

- Update the locked `solid-js` and `@solidjs/web` versions together.
- Set `jsxImportSource` to `@solidjs/web`.
- Import core and stores from `solid-js`; import DOM APIs and JSX types from
  `@solidjs/web`. `solid-js/web` and `solid-js/store` are gone.
- The client-only app has no router. Use browser history until one is justified.

## Components, files, and CSS

- `components/` is for files that each export **one JSX component**. It is a useful
  strict boundary: do not put helpers, state primitives, protocol code, or a group of
  unrelated components there.
- Put non-component helpers in a purpose-named directory such as `utils/` only when
  they exist and are shared. Do not create empty category directories in advance.
- Keep shared component styling in one `styles.css` until separate stylesheets earn
  their complexity. Scope selectors to the component's root class, not generic tags:

  ```tsx
  function SessionTabs() {
  return <header class="SessionTabs">...</header>
  }
  ```

  ```css
  .SessionTabs > button { ... }
  .SessionTabs > button.selected { ... }
  ```

  The root class matches the component name, so styles have an obvious owner and do
  not leak into another component's `button`, `h1`, or `main`.

## Reactivity

- Call signals and memos to read them. Writes are microtask-batched; do not rely
  on `setX(value); x()`. Use `flush()` only at imperative or test boundaries,
  not as a replacement for removed `batch()`.
- `createEffect(compute, apply)` tracks reads in `compute`; `apply` is untracked
  and performs side effects.
- Use `onSettled(() => { ...; return cleanup })` for component setup/teardown.
  `onCleanup` is for cleanup tied to a reactive computation.
- Do not write state during component rendering, memos, or effect computation.
  Read reactive values in JSX or computations, not at a component's top level.
- Pass prop values (`<X value={count()} />`), not accessors. Use `props.value`;
  destructuring props loses reactivity.
- Mutate store drafts: `setStore(draft => { draft.user.name = name })`. To
  preserve server-data identity, call `reconcile(data, key)(draft.branch)` in it.

## Solid 1 traps

- Async computations plus `<Loading>` replace `createResource`/`Suspense`.
  `Errored` replaces `ErrorBoundary`; `Reveal` replaces `SuspenseList`.
- `merge`, `omit`, and `onSettled` replace `mergeProps`, `splitProps`, and
  `onMount`; draft setters replace `produce`.
- Default `<For>` children get a value and index accessor; `keyed={false}` gives
  an item accessor and numeric index. `<Show>` function children get an accessor
  unless keyed.
- Context is its provider: `<Context value={value}>`. Refs are callbacks or
  callback arrays, not ref objects or `use:` directives.
- Use lowercase HTML attributes, camelCase events, and `class` arrays/objects,
  not `classList`, namespaces, or hand-built conditional class strings.

## Tests

- Resolve the `browser` and `development` conditions; otherwise Bun can load
  Solid's server build and make client reactivity appear broken.
- Give primitives an owner with `createRoot` outside render tests.
- `flush()` before assertions that observe queued state, effects, or DOM.

Source: [Solid 2 cheatsheet](https://github.com/solidjs/solid/blob/next/packages/solid/CHEATSHEET.md).
