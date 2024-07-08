# Cells

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

- When assigning the a value proxy to a cell, the underlying reference to the
  original cell is kept. This mimics JS semantics when referencing objects.
- Upon write a nested structure is turned into nested cells. This is to keep
  with JS semantics. Might be something we want to optimize later.
