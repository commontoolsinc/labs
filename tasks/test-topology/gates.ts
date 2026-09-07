/**
 * The repository's own gates: formatting, linting, the type check, the
 * pattern type check, the pattern update gates, and the checks that hold
 * a file or a document to a shape.
 *
 * The gates are two suites rather than one because a lane opens what a
 * suite needs before it runs any of it. Two of them read the revision the
 * change is measured against, which takes a checkout carrying history;
 * the rest read the working tree and need nothing but the toolchain. A
 * gate reaches a lane the way a test does: on what it is worth, or
 * because nothing has a record of it.
 */

import { collectPathsByScope, scopeOfPath } from "../typecheck.ts";
import * as path from "@std/path";
import {
  collectPatternFiles,
  PATTERN_TREES,
  patternKey,
} from "../pattern-files.ts";
import {
  claimsIdentity,
  type Invocation,
  type Location,
  type RecordSurface,
  type Suite,
  type UnitRequest,
} from "./suite.ts";
import type { CapabilityId } from "../ci-capabilities.ts";

/** One repository gate: what it is called, and what runs it. */
interface Gate {
  /** The name its record carries. */
  name: string;

  /** The record kind, which is `gate` for all but formatting and linting. */
  kind: string;

  /** The task that runs it. */
  task: string;

  /** Arguments the task takes beyond its own. */
  args?: (context: { baseRef: string }) => string[];

  /** Where it runs, repository-relative, when that is not the root. */
  cwd?: string;
}

/** The gates that read nothing but the working tree. */
const WORKING_TREE_GATES: readonly Gate[] = [
  { name: "deno-fmt", kind: "format", task: "fmt", args: () => ["--check"] },
  { name: "deno-lint", kind: "lint", task: "lint" },
  { name: "check-test-topology", kind: "gate", task: "check-test-topology" },
  { name: "check-skill-facts", kind: "gate", task: "check-skill-facts" },
  { name: "check-tripwires", kind: "gate", task: "check-tripwires" },
  { name: "check-docs", kind: "gate", task: "check-docs" },
  {
    name: "check-docs-history-index",
    kind: "gate",
    task: "check-docs-history-index",
  },
  { name: "check-no-waitfor", kind: "gate", task: "check-no-waitfor" },
  {
    name: "check-conflict-markers",
    kind: "gate",
    task: "check-conflict-markers",
  },
  {
    name: "check-control-characters",
    kind: "gate",
    task: "check-control-characters",
  },
  {
    name: "check-verb-session-sync",
    kind: "gate",
    task: "check-verb-session-sync",
  },
  { name: "check-pattern-tiers", kind: "gate", task: "check-pattern-tiers" },
  { name: "check-unused-deps", kind: "gate", task: "check-unused-deps" },
  { name: "check-deno-pins", kind: "gate", task: "check-deno-pins" },
  { name: "check-action-pins", kind: "gate", task: "check-action-pins" },
  {
    name: "check-single-copy-deps",
    kind: "gate",
    task: "check-single-copy-deps",
  },
  { name: "check-package-cycles", kind: "gate", task: "check-package-cycles" },
  { name: "check-local-program", kind: "gate", task: "check-local-program" },
  {
    name: "check-completion-slots",
    kind: "gate",
    task: "check-completion-slots",
  },
  { name: "check-command-docs", kind: "gate", task: "check-command-docs" },
  { name: "check-action-pins", kind: "gate", task: "check-action-pins" },
  { name: "check-pattern-tiers", kind: "gate", task: "check-pattern-tiers" },
  {
    name: "check-cfc-types",
    kind: "gate",
    task: "check-cfc-types",
    cwd: "packages/static",
  },
  {
    name: "check-commonfabric-types",
    kind: "gate",
    task: "check-commonfabric-types",
    cwd: "packages/static",
  },
  {
    name: "check-withheld-globals",
    kind: "gate",
    task: "check-withheld-globals",
    cwd: "packages/static",
  },
];

/**
 * The gates that hold a file to being appended to. Each reads the file as
 * it stood at the merge base with the revision the change is measured
 * against, which takes a checkout carrying history.
 */
const HISTORY_GATES: readonly Gate[] = [
  {
    name: "check-baselines-append-only",
    kind: "gate",
    task: "check-baselines-append-only",
    args: ({ baseRef }) => [baseRef],
  },
  {
    name: "check-test-aliases",
    kind: "gate",
    task: "check-test-aliases",
    args: ({ baseRef }) => [baseRef],
  },
];

/**
 * A suite of repository gates. Each gate is one unit holding one
 * identity, and running it is the whole of what a lane does with it, so
 * there is nothing finer to reach.
 */
function gateSuite(
  id: string,
  gates: readonly Gate[],
  needs: readonly CapabilityId[],
): Suite {
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const recordSurfaces: RecordSurface[] = [
    ...new Set(gates.map((gate) => gate.kind)),
  ].map((kind) => ({ kind, scope: "repo" }));
  return {
    id,
    recordSurfaces,
    needs,
    units: gates.map((gate) => gate.name),
    unavailable: [],
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      return byName.has(record.test.n)
        ? { level: "unit", unit: record.test.n }
        : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      const baseRef = context.baseRef ?? "origin/main";
      const invocations: Invocation[] = [];
      for (const request of requests) {
        const gate = byName.get(request.unit);
        if (gate === undefined) continue;
        invocations.push({
          command: [
            Deno.execPath(),
            "task",
            "run-recorded",
            gate.kind,
            "repo",
            gate.name,
            "--",
            Deno.execPath(),
            "task",
            gate.task,
            ...gate.args?.({ baseRef }) ?? [],
          ],
          cwd: gate.cwd === undefined
            ? context.root
            : `${context.root}/${gate.cwd}`,
        });
      }
      return Promise.resolve(invocations);
    },
  };
}

/**
 * The type check, one unit per package group. The store records one
 * identity per group and the mapping from a changed file to its group is
 * direct, so `unitsForChange` names exactly the groups a change touches.
 */
async function typecheckSuite(root: string): Promise<Suite> {
  const byScope = await collectPathsByScope(root);
  const scopes = [...byScope.keys()].sort();
  const known = new Set(scopes);
  const recordSurfaces = scopes.map((scope) => ({ kind: "typecheck", scope }));
  return {
    id: "typecheck",
    recordSurfaces,
    needs: ["deno"],
    units: scopes,
    unavailable: [],
    // A group's unit is the scope it checks rather than a path, so the
    // diff is mapped onto scopes the same way the check itself groups
    // the paths it walks.
    unitsForChange(changed) {
      const touched = new Set<string>();
      for (const path of changed) {
        const scope = scopeOfPath(path);
        if (known.has(scope)) touched.add(scope);
      }
      return [...touched];
    },
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      // `cfcheck` records under the same kind and its own names, so the
      // name is what separates the two.
      if (record.test.n !== "deno-check") return undefined;
      return known.has(record.test.s)
        ? { level: "unit", unit: record.test.s }
        : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      const named = requests
        .map((request) => request.unit)
        .filter((unit) => known.has(unit));
      if (named.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "check",
          ...named.map((scope) => `--scope=${scope}`),
        ],
        cwd: context.root,
      }]);
    },
  };
}

/**
 * The pattern type check. It writes one record per pattern file and
 * takes no way of running part of itself, so the suite is one unit and
 * every one of those records belongs to it.
 */
function cfcheckSuite(): Suite {
  const unit = "cfcheck";
  const recordSurfaces = [{ kind: "typecheck", scope: "repo" }];
  return {
    id: "cfcheck",
    recordSurfaces,
    needs: ["deno"],
    units: [unit],
    unavailable: [],
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      return record.test.n === unit || record.test.n.startsWith(`${unit} `)
        ? { level: "unit", unit }
        : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      if (requests.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "run-recorded",
          "typecheck",
          "repo",
          "cfcheck",
          "--",
          Deno.execPath(),
          "task",
          "cfcheck",
        ],
        cwd: context.root,
      }]);
    },
  };
}

/**
 * The pattern update compatibility gate, one unit per pattern. Its task
 * takes `--only` to restrict which patterns it reads, so a lane runs the
 * ones it was given. A run given every pattern passes no `--only` at
 * all, because the whole-tree questions the gate also answers — whether a
 * retired pattern still has a baseline, whether an accepted break has
 * gone orphaned — are only asked of an unfiltered run.
 */
async function patternCompatSuite(root: string): Promise<Suite> {
  // Collected against the root the topology was given rather than the
  // process's own directory: a lane runs from the repository root, and a
  // test of the topology runs from wherever its package does.
  const files = (await Promise.all(
    PATTERN_TREES.map((tree) =>
      collectPatternFiles(path.join(root, tree.directory))
    ),
  )).flat().sort().map((file) => path.relative(root, file));
  const byKey = new Map(files.map((file) => [patternKey(file), file]));
  const units = [...byKey.keys()].sort();
  const recordSurfaces = [{ kind: "gate", scope: "repo" }];
  const name = "pattern-compat";
  return {
    id: "pattern-compat",
    recordSurfaces,
    needs: ["deno"],
    units,
    unavailable: [],
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      if (record.test.n === name) return { level: "suite" };
      if (!record.test.n.startsWith(`${name} `)) return undefined;
      const key = record.test.n.slice(name.length + 1);
      return byKey.has(key) ? { level: "unit", unit: key } : undefined;
    },
    command(requests: readonly UnitRequest[], context): Promise<Invocation[]> {
      const keys = requests
        .map((request) => request.unit)
        .filter((unit) => byKey.has(unit));
      if (keys.length === 0) return Promise.resolve([]);
      const whole = keys.length === units.length;
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "run-recorded",
          "gate",
          "repo",
          name,
          "--",
          Deno.execPath(),
          "task",
          name,
          ...(whole ? [] : ["--only", ...keys.map((key) => byKey.get(key)!)]),
        ],
        cwd: context.root,
      }]);
    },
  };
}

/**
 * The vintage replay, which runs every committed fixture under today's
 * source. It records one identity per vintage and takes no way of
 * running part of itself, so the suite is one unit.
 */
function patternVintageSuite(): Suite {
  const unit = "pattern-vintage";
  const recordSurfaces = [{ kind: "gate", scope: "repo" }];
  return {
    id: "pattern-vintage",
    recordSurfaces,
    needs: ["deno", "git-history"],
    units: [unit],
    unavailable: [],
    locate(record): Location | undefined {
      if (!claimsIdentity({ recordSurfaces }, record.test)) return undefined;
      return record.test.n === unit || record.test.n.startsWith(`${unit} `)
        ? { level: "unit", unit }
        : undefined;
    },
    command(requests, context): Promise<Invocation[]> {
      if (requests.length === 0) return Promise.resolve([]);
      return Promise.resolve([{
        command: [
          Deno.execPath(),
          "task",
          "run-recorded",
          "gate",
          "repo",
          unit,
          "--",
          Deno.execPath(),
          "task",
          unit,
        ],
        cwd: context.root,
      }]);
    },
  };
}

/** Every gate suite, read from the working tree. */
export async function loadGateSuites(root: string): Promise<Suite[]> {
  return [
    gateSuite("repo-gates", WORKING_TREE_GATES, ["deno"]),
    gateSuite("repo-history-gates", HISTORY_GATES, ["deno", "git-history"]),
    await typecheckSuite(root),
    cfcheckSuite(),
    await patternCompatSuite(root),
    patternVintageSuite(),
  ];
}
