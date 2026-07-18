import {
  computed,
  Default,
  NAME,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * C2.9 session-lane gate fixture (context-lattice §7 C2 gate).
 *
 * The smallest pattern that carries EVERY lattice rank the C2 gate measures,
 * so claim ranks are forced by input scopes, not incidental:
 *
 *   - `myNote` (PerSession, writable) feeding the derived `tally` — the
 *     PerSession DERIVATION the server must claim at session rank and execute
 *     once per session's lane, landing rows under `session:<did>:<sid>`
 *     scope keys. `tally` also reads `board` (PerSpace) — the §7 (a)
 *     foreign-caused-recompute driver: ANY principal's board write
 *     invalidates every session's tally instance, and each recompute must
 *     settle under its own session's lane grant — and `myScore` (PerUser),
 *     the CA3 broader-in-chain leg: a session lane reading a user-scoped
 *     input must resolve the principal's real user instance (never a
 *     phantom default), so a mis-keyed read shows up as a wrong tally value
 *     or a claimed-commit conflict storm, not silence.
 *   - `myScore` (PerUser, writable) with the derived `doubled` — the
 *     user-rank leg. Under the session-stage rank ladder it must keep
 *     claiming at user rank, which also gives the Worker a USER-rank
 *     candidate template: the C2.7 template-rank guard leg asserts that
 *     template is never synthesized onto a session lane (and vice versa).
 *   - `board` (PerSpace, writable) with the derived `boardTotal` — the space
 *     lane control leg (C1.9's sponsor-overlap discipline at session stage):
 *     its declared space keys must survive session lanes opening in the same
 *     Worker.
 *
 * Deliberately no handlers, no map/ifElse chains (their write-surface
 * completeness is W2.15/W2.16's gate, re-verified separately per CA10), and
 * no cross-scope WRITES: every derivation's context floor is exactly the
 * narrowest of its read scopes.
 */

export interface SessionLaneTallyInput {
  board?: PerSpace<Writable<number[] | Default<[]>>>;
  myScore?: PerUser<Writable<number | Default<0>>>;
  myNote?: PerSession<Writable<number | Default<0>>>;
}

export interface SessionLaneTallyOutput {
  [NAME]: string;
  [UI]: VNode;
  board: PerSpace<Writable<number[] | Default<[]>>>;
  myScore: PerUser<Writable<number | Default<0>>>;
  myNote: PerSession<Writable<number | Default<0>>>;
  boardTotal: number;
  // Declared PerUser so the derived output's certificate is user-scoped
  // end-to-end (no §4 broad-instance widening leg) — same as C1.9.
  doubled: PerUser<number>;
  // Declared PerSession: the derived output's certificate is session-scoped
  // end-to-end; the value differs per session because `myNote` does.
  tally: PerSession<number>;
}

export default pattern<SessionLaneTallyInput, SessionLaneTallyOutput>(
  ({ board, myScore, myNote }) => {
    return {
      [NAME]: "Session lane tally fixture",
      [UI]: (
        <div>
          <span>session lane tally fixture</span>
        </div>
      ),
      board,
      myScore,
      myNote,
      boardTotal: computed(() => {
        let total = 0;
        for (const entry of board.get() ?? []) total += entry;
        return total;
      }),
      doubled: computed(() => (myScore.get() ?? 0) * 2),
      tally: computed(() => {
        let total = 0;
        for (const entry of board.get() ?? []) total += entry;
        return total + (myScore.get() ?? 0) + (myNote.get() ?? 0);
      }),
    };
  },
);
