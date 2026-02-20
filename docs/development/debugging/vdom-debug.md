# VDOM Debug Helpers

The `commontools.vdom` object provides browser console helpers for inspecting
the VDOM tree structure, applicator state, and DOM node mappings. These are
useful when debugging rendering issues — wrong/missing content, stale updates,
or broken reactivity.

## Quick Start

Open the browser console on any page with a rendered pattern:

```javascript
commontools.vdom.renders()         // list active renderings
await commontools.vdom.dump()      // pretty-print the VDOM tree
commontools.vdom.stats()           // node/listener counts
await commontools.vdom.tree()      // raw tree object for inspection
```

## Methods

### `renders()`

Lists all active renderings in a `console.table` with:

- **index** — position in the registry
- **container** — the DOM element being rendered into
- **cellId** — the cell ID backing this render
- **path** — `"worker"` (VDomRenderer) or `"legacy"` (main-thread)
- **renderer** — `"VDomRenderer"` or `"(legacy)"`

### `tree(el?)` (async)

Reads the VDOM cell using the **debug schema** and returns the raw tree object.
Children are expanded inline (not wrapped in CellHandles), so you can browse the
full tree structure in one shot. Props remain as CellHandles since prop values
can be large.

The optional `el` argument can be:

- omitted — uses the first/only active render
- a number — index into the active renders list
- an HTMLElement — the specific container element

### `dump(el?)` (async)

Pretty-prints the VDOM tree to the console. Output looks like:

```
<div className=<cell>>
  <h1>
    "Hello World"
  </h1>
  <span style=<cell>>
    "count: 42"
  </span>
</div>
```

- CellHandle props are shown as `<cell>`
- String children are quoted
- Self-closing tags for childless elements

### `stats()`

Shows a `console.table` of node and listener counts per active renderer. Only
meaningful for the worker path — legacy renders show `"(legacy)"`.

- **nodeCount** — number of DOM nodes tracked by the applicator
- **listenerCount** — number of nodes with event listeners
- **totalListeners** — total event listener count across all nodes
- **rootNodeId** — the applicator's root node ID

### `nodeForId(id, el?)`

Looks up a DOM node by its internal applicator node ID. Only works for
worker-path renders (the applicator tracks node IDs).

```javascript
const node = commontools.vdom.nodeForId(1)
// Returns the DOM element, or undefined
```

### `registry` (getter)

Raw access to the `Map<HTMLElement, ActiveRender>` for advanced inspection.

```javascript
commontools.vdom.registry
// Map(1) { div#app => { parent, cell, renderer, path } }
```

## The Debug Schema

The key difference between the normal rendering schema and the debug schema is
how children are handled:

| | Normal (`rendererVDOMSchema`) | Debug (`debugVDOMSchema`) |
|---|---|---|
| **Children** | Each child wrapped in `asCell` (separate reactive subscription) | No `asCell` — children expand inline |
| **Props** | `asCell` on each prop value | `asCell` on each prop value (unchanged) |

The normal schema uses `asCell` on children for performance — each child becomes
an independent reactive subscription, so only changed subtrees re-render. The
debug schema removes this so you can read the entire tree structure in one
`.get()` call, which is what you want when inspecting structure from the console.

Props keep `asCell` because prop values can be arbitrarily large (style objects,
data attributes) and aren't needed for structural debugging.

## Common Debugging Scenarios

### Stale render / content not updating

```javascript
// Check if the render is active
commontools.vdom.renders()

// Dump the tree to see current VDOM state
await commontools.vdom.dump()

// Compare with what's in the DOM
commontools.vdom.nodeForId(1)  // look up specific nodes
```

### Missing children

```javascript
// Get the raw tree and inspect children arrays
const tree = await commontools.vdom.tree()
console.log(tree.children)  // are children present in the VDOM?
```

### Wrong props

```javascript
// Get the tree and inspect a node's props
const tree = await commontools.vdom.tree()
// Props are CellHandles — call .get() on individual ones
tree.props.className.get()
```

### Multiple renders on the page

```javascript
// List all renders
commontools.vdom.renders()

// Target a specific one by index
await commontools.vdom.dump(0)  // first render
await commontools.vdom.dump(1)  // second render

// Or by container element
await commontools.vdom.dump(document.querySelector('#my-container'))
```

## See Also

- [Console Commands](console-commands.md) — full `commontools.*` reference
- [Logger System](logger-system.md) — structured logging and timing
