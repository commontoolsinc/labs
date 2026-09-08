/**
 * The commands continuous integration records that no lane can run.
 *
 * The topology's claim is that it declares every test surface, and the
 * store half of the drift guard holds it to that: an identity a run
 * produced that no suite claims fails. Two jobs produce such identities,
 * and neither is work a lane can be handed.
 *
 * The run's coverage gate joins every lane's coverage report, so it can
 * only start once the lanes have finished. It is a step of the run
 * rather than part of the corpus the run executes.
 *
 * The nightly property suite stands up real runtimes and real prompt
 * loops to write one corpus, and the audit beside it reads that corpus
 * as a population — a refusal count across the whole of it, a posture
 * held uniform across the whole of it — which is a question no single
 * run answers. The tests it runs also run on every change inside
 * `workspace-unit`, where each audits only its own run.
 *
 * So each is a unit and every one of them is unavailable, with the
 * reason it runs nowhere in the manifest beside every other deliberate
 * non-run. What runs them is the workflow, which is also where the
 * artifacts they read are fetched.
 */

import {
  claimsIdentity,
  type Invocation,
  type Location,
  type RecordSurface,
  type Suite,
  type Unavailable,
} from "./suite.ts";

/** One command a job records and no lane runs. */
interface OutOfLane {
  /** The kind and scope its record carries. */
  surface: RecordSurface;

  /** The name its record carries, which is also its unit. */
  name: string;

  /** Why no lane runs it. */
  reason: string;
}

const OUT_OF_LANE: readonly OutOfLane[] = [
  {
    surface: { kind: "gate", scope: "repo" },
    name: "coverage-check",
    reason: "it joins every lane's coverage report, so it can only run " +
      "once the lanes have finished",
  },
  {
    surface: { kind: "test", scope: "cf-harness" },
    name: "cfc-properties",
    reason: "it runs nightly, writing the one corpus its audit reads as a " +
      "population; every test in it also runs per change under " +
      "workspace-unit, auditing its own run",
  },
  {
    surface: { kind: "gate", scope: "cf-harness" },
    name: "cfc-audit-properties",
    reason: "it reads the corpus the nightly property suite wrote, which " +
      "no lane produces",
  },
];

/** The suite over those commands, every unit of it unavailable. */
export function loadOutOfLaneSuite(): Suite {
  const recordSurfaces: RecordSurface[] = [
    ...new Map(
      OUT_OF_LANE.map((entry) => [
        `${entry.surface.kind}\t${entry.surface.scope}`,
        entry.surface,
      ]),
    ).values(),
  ];
  const byName = new Map(OUT_OF_LANE.map((entry) => [entry.name, entry]));
  const unavailable: Unavailable[] = OUT_OF_LANE.map((entry) => ({
    unit: entry.name,
    reason: entry.reason,
  }));
  return {
    id: "out-of-lane",
    recordSurfaces,
    needs: [],
    units: OUT_OF_LANE.map((entry) => entry.name),
    unavailable,

    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      const entry = byName.get(record.test.n);
      if (entry === undefined) return undefined;
      return entry.surface.scope === record.test.s &&
          entry.surface.kind === record.test.k
        ? { level: "unit", unit: entry.name }
        : undefined;
    },

    // Every unit is unavailable, so a request naming one is a packer
    // that reached past that. Answering with no command would run
    // nothing and report the batch green, so it is refused instead, and
    // what runs these stays the workflow that fetches what they read.
    command(requests): Promise<Invocation[]> {
      if (requests.length > 0) {
        throw new Error(
          `out-of-lane was asked to run ${
            requests.map((request) => request.unit).join(", ")
          }, and no lane runs any of it`,
        );
      }
      return Promise.resolve([]);
    },
  };
}
