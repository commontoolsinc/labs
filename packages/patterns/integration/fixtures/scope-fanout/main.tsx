import {
  computed,
  Default,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * §5h.4 fan-out fixture — the two halves of the owner's scope-discovery
 * algorithm, side by side over the SAME shared input.
 *
 * > Run it at the declared scope. If it stays there, done. If it narrowed,
 * > make it the user's / session's run and start the adjacent ones.
 *
 *   - `boardTotal` reads ONLY the PerSpace `board`, so its scope STAYS at
 *     the declared space scope. One run must serve every interested
 *     principal — the case the inversion saves work on.
 *   - `myShare` reads the PerSpace `board` AND the PerUser `myScore`, so it
 *     NARROWS to user scope. The PerSpace half is what makes this fixture
 *     different from `user-lane-score`: a single shared `board` write
 *     invalidates EVERY interested principal's instance at once, so one
 *     trigger must produce one admitted value PER principal. In
 *     `user-lane-score` the PerUser derivation reads only PerUser state, so
 *     each principal necessarily triggers its own recompute and the fan-out
 *     question never arises.
 *
 * `doubled` is kept as the `user-lane-score` control: a PerUser derivation
 * with no shared input, whose recompute is always self-triggered.
 *
 * Deliberately no handlers and no cross-scope writes: every derivation's
 * context floor is exactly the narrowest of its read scopes, so the scope a
 * run "comes back at" is forced by the fixture rather than incidental.
 */

export interface ScopeFanoutInput {
  board?: PerSpace<Writable<number[] | Default<[]>>>;
  myScore?: PerUser<Writable<number | Default<0>>>;
}

export interface ScopeFanoutOutput {
  [NAME]: string;
  [UI]: VNode;
  board: PerSpace<Writable<number[] | Default<[]>>>;
  myScore: PerUser<Writable<number | Default<0>>>;
  /** STAYS at the declared space scope. */
  boardTotal: number;
  /** NARROWS to user scope; self-triggered only (the control leg). */
  doubled: PerUser<number>;
  /** NARROWS to user scope but is driven by the SHARED board — the fan-out
   * driver. Declared PerUser so the derived output's certificate is
   * user-scoped end to end (no §4 broad-instance widening leg). */
  myShare: PerUser<number>;
}

export default pattern<ScopeFanoutInput, ScopeFanoutOutput>(
  ({ board, myScore }) => {
    return {
      [NAME]: "Scope fan-out fixture",
      [UI]: (
        <div>
          <span>scope fan-out fixture</span>
        </div>
      ),
      board,
      myScore,
      boardTotal: computed(() => {
        let total = 0;
        for (const entry of board.get() ?? []) total += entry;
        return total;
      }),
      doubled: computed(() => (myScore.get() ?? 0) * 2),
      // The board total is scaled by 100 so every principal's share stays
      // distinguishable from the space-scoped `boardTotal` and from every
      // other principal's share: a mis-keyed instance shows up as a wrong
      // number rather than as a coincidence.
      myShare: computed(() => {
        let total = 0;
        for (const entry of board.get() ?? []) total += entry;
        return total * 100 + (myScore.get() ?? 0);
      }),
    };
  },
);
