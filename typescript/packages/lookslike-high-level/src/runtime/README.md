# Reactive cells & Native TS DX

## Nodes

Modules can be defined inline (and later referenced from the outside). When
written in this framework, they are functions that take values as parameters and
optionally return a value.

Functions can change incoming values and those changes are written to the
underlying cells at runtime. Returned values, if any, are also written to a
cell.

`const m = lift(fn)` turns such a module implementation `fn` into a node
factory. `const c = m(a, b)` then creates a node of that type, with `a` and `b`
as inputs and with results written to `c`.

Often, we want to create a one-off module and use it right away, and while
`const c = lift((a, b) => {...})(a, b)` works, it's a little hard to read, so
there is also `const c = apply([a, b], (a, b) => {...})` that defines a module
and right away uses it.

TODO: This is very similar to `compute` and `effect`, and so maybe we should use
these names instead. The main difference is that writing into the passed values
is allowed.

`const h = handler([a, b], (event, a, b) => { ... })` defines a handler for
`event` that takes cells `a` and `b` as parameters, often to write into (!). `h`
can be used as the target of an event source in e.g. the UI. If `handler` is the
analogue to `apply`, then `asHandler` is the analogue to `lift` and creates a
handler factory that has to be called with the cells to be bound.

`propagator(fn)` is similar to `lift`, but the function receives the cells as
parameters, and so the code has to use `.get()` and `.send()` on them, and there
is no return value. Just a different style. Note that this is not configuring a
graph, it will be called when one of the read inputs changed. Use `recipe` for
graph creation (see below)

`const curried = curry([a], (a, b) => {...})` creates a node type with `a`
already bound. `curried(b)` then creates a node. Useful to configure more
general purpose modules.

### Merging

Sometimes we'd like to write the output of a lifted function into an existing
cell: `merge(to, from)` is a helper to do that. Under the hood it copies all
updates to `from` to `to`. It's a one-way LWR "merge". TODO: Build more
sophisticated ones.

### Structured values

Cells represent nested data, that can be directly referenced. Both of these
work:

- `const c = m1(a, b); const d = m2(c.foo)`
- `const { foo } = m1(a, b); const d = m2(foo)`

TODO: Instead of functions with N parameters, we could only have one parameter
and pass objects with named values around:

- This makes it compatible with `recipe` calls and is pretty much already
  working.
- And since recipes can be used a modules, this would also make them
  indistinguishable from code modules when written in a recipe, which seems
  good.
- And it makes writing into cells for literal values a little better: The issue
  otherwise is that once `.get()` is called on a literal cell, it's just a
  literal value and can't be written to. A workaround is to pass `{ value:
<cell> }`, so that in the code we have a handle for it. If all parameters are
  passed like this, then that isn't necessary – however destructuring in the
  function definition undos this again, so we'll have to write `(params) => {
  const { foo, bar } = params; params.bar = newValue }`.

## Recipes

Recipes are graphs, specifically a set of modules bound to a set of cells. Some
of these cells are inputs and outputs of the recipe, that is, they can be passed
in from the outside (for inputs) and used by other recipes (for outputs). Cells
can be both input and output. And cells can have initial values (which for input
cells act as default values, if they aren't provided).

Recipes are defined by a function. That function is called only once, to create
the graph. And while cells are passed in, the function can't call `.get()` or
`.send()` on them: Instead it'll have to define a module (see above) to perform
computations.

Define a recipe by calling `recipe(fn)`, where `fn` takes a bag of input cells
and returns a bag of output cells.

TODO: Where should we define the schema?

TODO: Recipes can be used in other recipes, just like the result of `lift`.

## Cells

Three layers:

1. Underlying cells of type T, which have

   - `.get(): T` -- gets the current value
   - `.send(value: T)` -- update with that value
   - `.updates(Sendable): Cancel` -- subscribe to changes

2. Proxies of these cells, with the same methods, but with properties returning
   more proxies to express a path. E.g. `cell.foo.bar` selects `bar` in foo in
   `cell`. The path is lazily evaluated upon `get()`.

   It also exposes a `.withLog(log: ReactivityLog)` method that returns another
   proxy, whose reads and writes will be logged.

3. Value proxies, returned by `get()` on a cell proxy. Properties expand to
   further `get()` calls, and setters become `send()` calls.

Most of the time, you'll only need this:

- `const c = cell(<initial value>)` retuns a cell proxy: Used when constructing
  a graph.
- `c.withLog(log).get()` returns the value proxy, logging uses. These are passed
  to code that reads from and writes to cells, via the value proxies.

Some internas to note:

- Cells are meant as drop-in replacement of common-frp cells
- When assigning the a value proxy to a cell, the underlying reference to the
  original cell is kept. This mimics JS semantics when referencing objects.
- Upon write a nested structure is turned into nested cells. This is to keep
  with JS semantics. Might be something we want to optimize later.
