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
 * C1.9 two-principal user-lane gate fixture (context-lattice §7 C1 gate).
 *
 * The smallest pattern that carries BOTH lattice lanes the gate measures:
 *
 *   - `myScore` (PerUser, writable) with the derived `doubled` — the PerUser
 *     DERIVATION the server must claim at user rank and execute once per
 *     principal's lane, landing rows under `user:<did>` scope keys;
 *   - `board` (PerSpace, writable) with the derived `boardTotal` — the space
 *     lane control leg: it stays claimable at space rank with the user dials
 *     both on AND off, and its declared space keys must survive a user lane
 *     opening for the sponsor's own principal (the C1.5b overlap fixture).
 *
 * Deliberately no handlers and no cross-scope reads: every derivation's
 * context floor is exactly its input's scope, so claim ranks are forced, not
 * incidental.
 */

export interface UserLaneScoreInput {
  board?: PerSpace<Writable<number[] | Default<[]>>>;
  myScore?: PerUser<Writable<number | Default<0>>>;
}

export interface UserLaneScoreOutput {
  [NAME]: string;
  [UI]: VNode;
  board: PerSpace<Writable<number[] | Default<[]>>>;
  myScore: PerUser<Writable<number | Default<0>>>;
  boardTotal: number;
  // Declared PerUser so the derived output's certificate is user-scoped
  // end-to-end: the lift writes ONLY the acting principal's instance, with
  // no §4 broad-instance widening leg.
  doubled: PerUser<number>;
}

export default pattern<UserLaneScoreInput, UserLaneScoreOutput>(
  ({ board, myScore }) => {
    return {
      [NAME]: "User lane score fixture",
      [UI]: (
        <div>
          <span>user lane score fixture</span>
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
    };
  },
);
