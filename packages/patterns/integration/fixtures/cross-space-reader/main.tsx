import {
  computed,
  Default,
  NAME,
  pattern,
  type PerSpace,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * C3.11 cross-space-read gate fixture (context-lattice §7 C3 gate).
 *
 * The smallest AUTHORED pattern that expresses a cross-space READ derivation:
 * a space-scoped `computed` (`doubled`) that reads a foreign-space-linked
 * cell (`source`). At instantiation the gate binds `source` to a cell that
 * lives in a DIFFERENT space (space B) — a genuine cross-space link — so the
 * derivation's observed read address names space B while the piece (and every
 * write) stays home in space A. That is exactly the shape the C3.6 servability
 * classifier admits under the cross-space-read stage: a SPACE-scoped foreign
 * read whose space joins the claim's `crossSpaceReadSpaces`, with the home
 * output space-scoped and same-space.
 *
 * Deliberately minimal — no handlers, no scoped (user/session) inputs, no
 * cross-space WRITES (decision #3: v1 foreign reads are space-scoped only;
 * foreign writes stay client-authoritative). The only cross-space element is
 * the single foreign READ that `doubled` folds, which is the whole point of
 * the gate.
 *
 * `source` is echoed as an output so the gate can address the home piece's
 * argument link; the derivation the executor claims and reruns is `doubled`.
 */

export interface CrossSpaceReaderInput {
  /** Bound at instantiation to a cell in space B — a cross-space link. */
  source?: Writable<number | Default<0>>;
}

export interface CrossSpaceReaderOutput {
  [NAME]: string;
  [UI]: VNode;
  source: Writable<number | Default<0>>;
  /** The cross-space-read derivation: space-scoped output over a foreign
   * (space B) read. This is the action the server claims at cross-space-read
   * stage and reruns over the foreign point-read channel. */
  doubled: PerSpace<number>;
}

export default pattern<CrossSpaceReaderInput, CrossSpaceReaderOutput>(
  ({ source }) => {
    return {
      [NAME]: "Cross-space reader fixture",
      [UI]: (
        <div>
          <span>cross-space reader fixture</span>
        </div>
      ),
      source,
      doubled: computed(() => (source.get() ?? 0) * 2),
    };
  },
);
