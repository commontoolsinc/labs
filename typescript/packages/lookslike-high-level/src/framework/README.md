# Recipe DX

When creating recipes all cells are really proxies for future cells. They can be
nested and assigned to each other.

## Internal structure

`recipe` creates an internal representation, which is effectively:

- the default value for the cell representing the recipe, which includes all
  constants
- nodes, which are defined by
  - module
  - input cell expressed as bound data structure
  - output cell expressed as bound data structure, if any

Bound data structures, which are also used for UI, are static data, where some
fields can be cell proxies. For the recipe, it is both inputs and outputs and
aliasing within the cell is allowed (loops are not, of course). For module
inputs, the idea is that when the recipe is run, the data is collected from
those cells. For module outputs, the result is effectively destructured into the
corresponding cells.

When invoking a recipe from another recipe, the graphs can be combined: The
recipe cell is being created, with the default values optionally overriden by
cell aliasing to the caller cells.

## Aliasing cells

```ts
const { foo, bar } = recipeCell;
const { baz } = example({ bar });
foo.set(baz);
```

Means that the key 'baz' on the output of `example` should be assigned to
`recipeCell.foo`. We can do this in a few ways:

- Create another subpath on `recipeCell` for the output of `example` and do an
  internal path alias.
- On the `example` node, add an annotation of where data should flow, i.e. the
  reverse binding above, here `{ baz: recipeCell.foo }`.

For now, we just assign a default cell and reference "forward". Later we could
do a pass to optimize these away somewhat.

---

When invoking a recipe, the following steps happen:

- The recipe is invoked with the cell it should populate (almost always that's a
  new cell, prefilled with references to inputs)
- Default values are populated, unless there is already something there
- Initial values are populated, overwriting what is there already
- Nodes are registered with inputs as assumed dependencies
- ...
