/**
 * What a test surface has to say about itself to join the topology, and
 * the parts every `deno test` suite says the same way.
 *
 * The interface is deliberately small. A suite lists what its runner can
 * be pointed at, recognizes its own records, and builds the command for a
 * chosen subset; everything else — scoring, packing, which lane runs what
 * — is somebody else's problem and stays that way.
 */

import * as path from "@std/path";
import {
  preloadArgument,
  serializeSkipList,
  SKIP_LIST_VARIABLE,
  type SkipList,
  type TestIdentity,
} from "@commonfabric/test-support/records";
import type { CapabilityId } from "../ci-capabilities.ts";

/** A kind and scope a suite's records may carry. */
export interface RecordSurface {
  kind: string;
  scope: string;
}

/**
 * The smallest thing a suite's runner can be asked to run: a
 * repository-relative test file, a dispatch arm of a shell script, a
 * workspace member whose test task cannot be handed a subset. It holds
 * one identity or many.
 */
export type Unit = string;

/** A unit or exact leaf this configuration deliberately does not run. */
export interface Unavailable {
  unit: Unit;

  /** The one identity inside the unit, when the rest of it still runs. */
  leafName?: string;

  /** Which part of the work it is unavailable for. */
  phase?: string;

  /** Why, in words a person reads. */
  reason: string;
}

/** What walking the working tree found. */
export interface Enumeration {
  units: Unit[];
  unavailable: Unavailable[];
}

/** Whether a record belongs to one unit or to the suite as a whole. */
export type Location = { level: "unit"; unit: Unit } | { level: "suite" };

/** A record as the topology reads it: its identity and where it came from. */
export interface LocatableRecord {
  test: TestIdentity;

  /** The repository-relative source file, where the producer knew it. */
  file?: string;
}

/** One unit, and the identities inside it this invocation is not to run. */
export interface UnitRequest {
  unit: Unit;

  /**
   * Names inside the unit to register as ignored. Empty means run all of
   * them, which is what a unit selected whole asks for.
   */
  skip: readonly string[];
}

/** One JUnit report an invocation writes, and how to read it. */
export interface JUnitOutput {
  path: string;
  kind: string;
  scope: string;

  /** Prefixed onto a report's own file paths to reach the repository root. */
  filePrefix?: string;
}

/** One command a suite runs, and what it leaves behind. */
export interface Invocation {
  command: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  junit?: readonly JUnitOutput[];
}

/** What a suite is given when it builds its commands. */
export interface CommandContext {
  /** The repository root, absolute. */
  root: string;

  /**
   * A directory this batch owns. Reports and skip lists go here, and the
   * lane runner gives every execution of a batch a fresh one so a repeat
   * cannot read the previous run's report.
   */
  outputDir: string;

  /**
   * Where coverage profiles go, one directory per workspace member.
   * Absent where this batch is not being measured, which is every batch
   * outside the per-package coverage gate and the full run.
   */
  coverageDir?: string;

  /**
   * What this change is measured against, as a git revision. The gates
   * that hold a file to being appended to compare against it.
   */
  baseRef?: string;
}

/** One test surface. */
export interface Suite {
  /** Stable identifier. Appears in manifests, logs, and timing records. */
  id: string;

  /** Every kind and scope this suite's records may carry. */
  recordSurfaces: readonly RecordSurface[];

  /** The non-default configuration every one of its units runs in. */
  variant?: string;

  /** Setup this suite needs before it can run. */
  needs: readonly CapabilityId[];

  /** Whether a subset of it always runs, and on what basis. */
  mandatory?: "always" | "changed";

  /**
   * Every unit available in this working tree. Read when the topology is
   * loaded rather than on demand, because `locate` answers from the same
   * reading and has to answer without waiting.
   */
  units: readonly Unit[];

  /** Every unit or exact leaf this configuration deliberately does not run. */
  unavailable: readonly Unavailable[];

  /**
   * Tree paths this suite accounts for beyond its units. A suite whose
   * units are files needs none; a suite whose units are dispatch arms
   * names the scripts those arms run, so the drift guard can tell that
   * the script is registered rather than missed.
   */
  sources?: readonly string[];

  /** Whether a record belongs to one of this suite's units, or to it. */
  locate(record: LocatableRecord): Location | undefined;

  /** The commands that run exactly these units, and their reports. */
  command(
    units: readonly UnitRequest[],
    context: CommandContext,
  ): Promise<Invocation[]>;
}

/**
 * Whether an identity is one this suite could have produced: its kind and
 * scope are among the declared surfaces, and its variant is exactly the
 * suite's. An unmarked record therefore reaches only a default suite, and
 * a marked one only the suite carrying that marker.
 */
export function claimsIdentity(
  suite: Pick<Suite, "recordSurfaces" | "variant">,
  test: TestIdentity,
): boolean {
  if (test.v !== suite.variant) return false;
  return suite.recordSurfaces.some(
    (surface) => surface.kind === test.k && surface.scope === test.s,
  );
}

/** Writes a batch's skip list where its invocations will read it. */
export async function writeSkipList(
  skipListPath: string,
  skips: SkipList,
): Promise<void> {
  if (Object.keys(skips).length === 0) return;
  await Deno.mkdir(path.dirname(skipListPath), { recursive: true });
  await Deno.writeTextFile(skipListPath, serializeSkipList(skips));
}

/** The skip list a set of unit requests comes to. */
export function skipListOf(units: readonly UnitRequest[]): SkipList {
  const skips: SkipList = {};
  for (const request of units) {
    if (request.skip.length === 0) continue;
    skips[request.unit] = [...request.skip];
  }
  return skips;
}

/** One package's share of a `deno test` suite. */
export interface FilePart {
  /** Where `deno test` runs, repository-relative. */
  packageDir: string;

  /** Flags between `deno test` and the file list. */
  flags: readonly string[];

  env?: Record<string, string>;

  /** How the report this part writes is read back. */
  junit: Omit<JUnitOutput, "path">;

  /** Every available test file of this part, repository-relative. */
  files: readonly string[];

  /** Every file or leaf this configuration deliberately does not run. */
  unavailable?: readonly Unavailable[];

  /**
   * The unit a record belongs to, where that is not the `file` the
   * producer recorded. A pattern test's identity is its path, so its
   * suite answers from the name instead.
   */
  unitOf?: (record: LocatableRecord) => string | undefined;
}

/** What a suite of `deno test` files is built from. */
export interface FileSuiteOptions {
  id: string;
  variant?: string;
  needs: readonly CapabilityId[];
  mandatory?: "always" | "changed";

  /**
   * The packages it spans. One runner does not imply one scope: the
   * package integration command spans three packages, each with its own
   * directory and its own record scope.
   */
  parts: readonly FilePart[];
}

/**
 * A suite whose runner is `deno test` over a set of files. Most of the
 * topology is this shape, and what differs between them is the files, the
 * flags, and what their records are called.
 */
export function fileSuite(options: FileSuiteOptions): Suite {
  const units: string[] = [];
  const partOf = new Map<string, FilePart>();
  const recordSurfaces: RecordSurface[] = [];
  const unavailable: Unavailable[] = [];
  for (const part of options.parts) {
    recordSurfaces.push({ kind: part.junit.kind, scope: part.junit.scope });
    for (const file of part.files) {
      units.push(file);
      partOf.set(file, part);
    }
    unavailable.push(...part.unavailable ?? []);
  }
  const surfaces = {
    recordSurfaces,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  };
  return {
    id: options.id,
    recordSurfaces,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    needs: options.needs,
    ...(options.mandatory === undefined
      ? {}
      : { mandatory: options.mandatory }),
    units,
    unavailable,

    locate(record) {
      if (!claimsIdentity(surfaces, record.test)) return undefined;
      for (const part of options.parts) {
        if (part.junit.scope !== record.test.s) continue;
        if (part.junit.kind !== record.test.k) continue;
        const unit = (part.unitOf ?? ((r: LocatableRecord) => r.file))(record);
        if (unit !== undefined && partOf.get(unit) === part) {
          return { level: "unit", unit };
        }
      }
      return undefined;
    },

    async command(requests, context) {
      const byPart = new Map<FilePart, UnitRequest[]>();
      for (const request of requests) {
        const part = partOf.get(request.unit);
        if (part === undefined) continue;
        const group = byPart.get(part);
        if (group === undefined) byPart.set(part, [request]);
        else group.push(request);
      }
      const invocations: Invocation[] = [];
      for (const [part, group] of byPart) {
        const cwd = path.resolve(context.root, part.packageDir);
        const slug = `${options.id}-${part.junit.scope.replaceAll("/", "__")}`;
        const junitPath = path.join(context.outputDir, `${slug}.xml`);
        const skips = skipListOf(group);
        const env: Record<string, string> = { ...part.env };
        if (Object.keys(skips).length > 0) {
          const skipListPath = path.join(
            context.outputDir,
            `${slug}.skip.json`,
          );
          await writeSkipList(skipListPath, skips);
          env[SKIP_LIST_VARIABLE] = skipListPath;
        }
        if (context.coverageDir !== undefined) {
          env.DENO_COVERAGE_DIR = path.join(context.coverageDir, slug);
        }
        invocations.push({
          command: [
            Deno.execPath(),
            "test",
            ...part.flags,
            preloadArgument(),
            `--junit-path=${junitPath}`,
            ...group.map((request) =>
              path.relative(cwd, path.resolve(context.root, request.unit))
            ),
          ],
          cwd,
          env,
          junit: [{ path: junitPath, ...part.junit }],
        });
      }
      return invocations;
    },
  };
}
