// `@options` JSDoc on a property lowers to `x-options`: the path in the
// piece's result its options are read from, and the path of their labels when
// a second path is given. A verb listing resolves it into an `enum`.
interface SchemaRoot {
  /** Id of the ring, as `rings` lists it.
   * @options rings[].id rings[].label */
  ring: string;

  /** @options lanes[] */
  lane: string;

  cells: {
    /** Ring of the cell.
     * @options rings[].id */
    ring: string;
  }[];

  /** No options named. */
  step: number;
}
