import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createResumeRecovery,
  type ResumeRecovery,
} from "../src/builtins/resume-recover.ts";

// Unit coverage for the post-sync recovery helper, exercised directly against a
// mock runtime so it is deterministic (no timing or transport window): it
// re-runs the op with the element's CURRENT index at recovery time, skips when
// the element already holds a value or its run was superseded, and reports (does
// not throw on) a failed commit or a failed sync wait.

type RecoveryOptions = Parameters<typeof createResumeRecovery>[0];
type RecoveryRuntime = RecoveryOptions["runtime"];
type RecoverySpace = RecoveryOptions["space"];
type RecoveryElementRuns = RecoveryOptions["elementRuns"];
type RecoveryLogger = RecoveryOptions["logger"];
type RecoveryScheduleArgs = Parameters<ResumeRecovery["schedule"]>;
type RecoveryResultCell = RecoveryScheduleArgs[1];
type RecoveryPattern = RecoveryScheduleArgs[2];
type RecoveryTransaction = Parameters<
  RecoveryRuntime["editWithRetry"]
>[0] extends (tx: infer Tx) => unknown ? Tx
  : never;
type ResultCellFixture = RecoveryResultCell & {
  withTx(tx: RecoveryTransaction): { getRaw(): unknown };
};
interface Setup {
  recovery: ResumeRecovery;
  resultCell: RecoveryResultCell;
  state: {
    runInputs: unknown[];
    warnings: number;
    tracked: Promise<unknown>[];
  };
}

function setup(opts: {
  editError?: unknown;
  getRaw?: () => unknown;
  lastIndex?: number;
  supersede?: boolean;
  syncRejects?: boolean;
  noSynced?: boolean;
}): Setup {
  const state = {
    runInputs: [] as unknown[],
    warnings: 0,
    tracked: [] as Promise<unknown>[],
  };
  const resultCell = {
    withTx: () => ({ getRaw: opts.getRaw ?? (() => undefined) }),
  } as ResultCellFixture;
  const elementRuns: RecoveryElementRuns = new Map();
  if (!opts.supersede) {
    elementRuns.set("k", { resultCell, lastIndex: opts.lastIndex ?? 4 });
  }
  const runtime: RecoveryRuntime = Object.assign({} as RecoveryRuntime, {
    storageManager: {
      open: () =>
        opts.noSynced ? {} : {
          synced: () =>
            opts.syncRejects
              ? Promise.reject(new Error("sync failed"))
              : Promise.resolve(),
        },
      trackUntilSettled: (p: Promise<unknown>) => state.tracked.push(p),
    },
    editWithRetry: (fn: (tx: unknown) => void) => {
      fn({});
      return Promise.resolve(
        opts.editError !== undefined ? { error: opts.editError } : { ok: {} },
      );
    },
    runner: {
      run: (_tx: unknown, _op: unknown, runInput: unknown) =>
        state.runInputs.push(runInput),
    },
  });
  const logger: RecoveryLogger = Object.assign({} as RecoveryLogger, {
    warn: () => {
      state.warnings++;
    },
  });
  const recovery = createResumeRecovery({
    runtime,
    space: "did:key:z6Mk-resume-recover-unit" as RecoverySpace,
    elementRuns,
    logger,
  });
  return { recovery, resultCell, state };
}

const opPattern: RecoveryPattern = {
  argumentSchema: true,
  resultSchema: true,
  result: {},
  nodes: [],
};

async function drive(
  s: Setup,
  buildRunInput: (index: number) => Record<string, unknown> = (index) => ({
    index,
  }),
): Promise<void> {
  s.recovery.schedule("k", s.resultCell, opPattern, buildRunInput);
  await Promise.all(s.state.tracked);
}

describe("resume recovery helper", () => {
  it("re-runs the op with the element's current index, not a captured one", async () => {
    const s = setup({ lastIndex: 7 });
    await drive(s);
    // buildRunInput is invoked with the element-runs entry's current lastIndex,
    // so a reordered element recovers with the position it now holds.
    expect(s.state.runInputs).toEqual([{ index: 7 }]);
    expect(s.state.warnings).toBe(0);
  });

  it("does not re-run when the element already holds a value", async () => {
    const s = setup({ getRaw: () => 42 });
    await drive(s);
    expect(s.state.runInputs).toEqual([]);
  });

  it("does not re-run when the element run was superseded", async () => {
    const s = setup({ supersede: true });
    await drive(s);
    expect(s.state.runInputs).toEqual([]);
  });

  it("reports a failed recovery commit without throwing", async () => {
    const s = setup({ editError: new Error("conflict") });
    await drive(s);
    expect(s.state.warnings).toBe(1);
  });

  it("reports a failed sync wait without throwing", async () => {
    const s = setup({ syncRejects: true });
    await drive(s);
    expect(s.state.runInputs).toEqual([]);
    expect(s.state.warnings).toBe(1);
  });

  it("does nothing when the provider cannot observe sync", async () => {
    const s = setup({ noSynced: true });
    await drive(s);
    expect(s.state.tracked).toEqual([]);
    expect(s.state.runInputs).toEqual([]);
  });

  it("arms at most one recovery per key at a time", async () => {
    const s = setup({});
    s.recovery.schedule("k", s.resultCell, opPattern, (index) => ({ index }));
    s.recovery.schedule("k", s.resultCell, opPattern, (index) => ({ index }));
    await Promise.all(s.state.tracked);
    // The second schedule is ignored while the first is in flight.
    expect(s.state.tracked.length).toBe(1);
  });
});
