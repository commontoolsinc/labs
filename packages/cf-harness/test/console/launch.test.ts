import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type ConsoleLaunchRecords,
  consoleLaunchReport,
  DEPLOYMENT_PATTERN_INDEX_URL,
  DEPLOYMENT_SKILLS_REGISTRY_URL,
  LAUNCHER_OWNED_VARIABLES,
  resolveConsoleLaunchPlan,
  WEAVER_PAIRING_PORT,
} from "../../console/launch.ts";

const PIECES_JSON = JSON.stringify({
  defaults: {
    identity: "/keys/instance.key",
    local_space: "ben-loom-dev-6",
    server_urls: { toolshed: "http://localhost:8001" },
  },
});

const DOCKER_RUNTIMES = {
  "runsc-cfc": {
    path: "/host_mnt/store/runsc-cfc/runsc",
    runtimeArgs: [
      "--cfc",
      "--cfc-result-dir=/host_mnt/store/runsc-cfc/sidecars/results",
      "--cfc-invocation-context-dir=/host_mnt/store/runsc-cfc/sidecars/ctx",
    ],
  },
};

const RECORDS: ConsoleLaunchRecords = {
  instance: {
    id: "loom",
    piecesJson: PIECES_JSON,
    piecesJsonPath: "/loom/instances/loom/pieces.json",
    toolshedStoreDir:
      "file:///loom/instances/loom/toolshed-store/68239506e79d/",
  },
  dockerRuntimes: DOCKER_RUNTIMES,
};

const OPTIONS = {
  patternIndexUrl: "https://index.example",
  skillsRegistryUrl: "https://skills.example",
};

/** The same fabric, named on the command line rather than read off loom. */
const NAMED_FABRIC = {
  ...OPTIONS,
  identity: "/keys/dev.key",
  space: "cf-harness-dev",
  toolshedUrl: "http://localhost:8000",
  store: "/checkout/packages/toolshed/cache/memory",
};

const NO_INSTANCE: ConsoleLaunchRecords = { dockerRuntimes: DOCKER_RUNTIMES };

const withPieces = (
  defaults: Record<string, unknown>,
): ConsoleLaunchRecords => ({
  ...RECORDS,
  instance: { ...RECORDS.instance!, piecesJson: JSON.stringify({ defaults }) },
});

describe("launch", () => {
  describe("resolveConsoleLaunchPlan()", () => {
    it("returns the identity, space and toolshed the instance records", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe(
        "/keys/instance.key",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("ben-loom-dev-6");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8001",
      );
    });

    it("returns the store as a path rather than the `file://` URL loom printed", () => {
      // The space store reader walks `MEMORY_DIR` as a directory. Handed a
      // `file://` URL it walks nothing, falls through to its other candidate
      // roots, and reads another store's cells as this space's.

      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.MEMORY_DIR).toBe(
        "/loom/instances/loom/toolshed-store/68239506e79d/",
      );
    });

    it("returns a store loom printed as a plain path unchanged", () => {
      const plan = resolveConsoleLaunchPlan(
        {
          ...RECORDS,
          instance: {
            ...RECORDS.instance!,
            toolshedStoreDir: "/loom/store/memory/",
          },
        },
        OPTIONS,
      );

      expect(plan.environment.MEMORY_DIR).toBe("/loom/store/memory/");
    });

    it("returns the sidecar directories the registered runtime names, as host paths", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/runsc-cfc/sidecars/results",
      );
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR).toBe(
        "/store/runsc-cfc/sidecars/ctx",
      );
    });

    it("returns the Weaver pairing port and a console directory naming it", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe(
        String(WEAVER_PAIRING_PORT),
      );
      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        `.cf-harness-console-loom-${WEAVER_PAIRING_PORT}`,
      );
    });

    it("returns the port the instance records, as loom's proxy resolves it", () => {
      // The daemon's proxy target and the console's bind port read the same
      // inputs in the same order, so one record moves both.

      const plan = resolveConsoleLaunchPlan(
        withPieces({
          identity: "/keys/instance.key",
          local_space: "ben-loom-dev-6",
          server_urls: { toolshed: "http://localhost:8001" },
          harness_console_port: 8136,
        }),
        OPTIONS,
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe("8136");
      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        ".cf-harness-console-loom-8136",
      );
    });

    it("returns a named port over the one the instance records", () => {
      const plan = resolveConsoleLaunchPlan(
        withPieces({
          identity: "/keys/instance.key",
          local_space: "s",
          server_urls: { toolshed: "http://localhost:8001" },
          harness_console_port: 8136,
        }),
        { ...OPTIONS, port: 8140 },
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe("8140");
    });

    it("returns the pairing port for a recorded value that is not a port", () => {
      const plan = resolveConsoleLaunchPlan(
        withPieces({
          identity: "/keys/instance.key",
          local_space: "s",
          server_urls: { toolshed: "http://localhost:8001" },
          harness_console_port: "not a port",
        }),
        OPTIONS,
      );

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe(
        String(WEAVER_PAIRING_PORT),
      );
    });

    it("returns a distinct console directory for each port", () => {
      const first = resolveConsoleLaunchPlan(RECORDS, {
        ...OPTIONS,
        port: 8136,
      });
      const second = resolveConsoleLaunchPlan(RECORDS, {
        ...OPTIONS,
        port: 8137,
      });

      expect(first.environment.CF_HARNESS_CONSOLE_DIR).not.toBe(
        second.environment.CF_HARNESS_CONSOLE_DIR,
      );
    });

    it("returns the enforcing posture with flow labels persisted", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_FABRIC_CFC_POSTURE).toBe(
        "max-enforcement",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_FLOW_LABELS).toBe(
        "persist",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE).toBe(
        "enforce-explicit",
      );
    });

    it("returns a named value over the record that would decide it", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {
        ...OPTIONS,
        consoleDir: "/consoles/branch",
        cfcResultDir: "/elsewhere/results",
        posture: "none",
      });

      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe("/consoles/branch");
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/elsewhere/results",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_CFC_POSTURE).toBe("none");
    });

    it("leaves the index and the registry out of the environment when waived", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {
        noPatternIndex: true,
        noSkillsRegistry: true,
      });

      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBeUndefined();
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBeUndefined();
    });

    it("throws naming `--fabric-identity` when nothing records one", () => {
      expect(() =>
        resolveConsoleLaunchPlan(
          withPieces({
            local_space: "s",
            server_urls: { toolshed: "http://localhost:8001" },
          }),
          OPTIONS,
        )
      ).toThrow("`--fabric-identity`");
    });

    it("throws naming `--fabric-space` when nothing records one", () => {
      expect(() =>
        resolveConsoleLaunchPlan(
          withPieces({
            identity: "/keys/instance.key",
            server_urls: { toolshed: "http://localhost:8001" },
          }),
          OPTIONS,
        )
      ).toThrow("`--fabric-space`");
    });

    it("throws naming `--fabric-api-url` when nothing records one", () => {
      expect(() =>
        resolveConsoleLaunchPlan(
          withPieces({ identity: "/keys/instance.key", local_space: "s" }),
          OPTIONS,
        )
      ).toThrow("`--fabric-api-url`");
    });

    it("throws naming `--store` when loom printed none", () => {
      expect(() =>
        resolveConsoleLaunchPlan({
          ...RECORDS,
          instance: { ...RECORDS.instance!, toolshedStoreDir: "" },
        }, OPTIONS)
      ).toThrow("`--store`");
    });

    it("throws naming `--cfc-result-dir` when no runtime registration names it", () => {
      const { dockerRuntimes: _omitted, ...withoutDocker } = RECORDS;

      expect(() => resolveConsoleLaunchPlan(withoutDocker, OPTIONS)).toThrow(
        "`--cfc-result-dir`",
      );
    });

    it("throws carrying the reason the runtime table could not be read", () => {
      const { dockerRuntimes: _omitted, ...withoutDocker } = RECORDS;

      expect(() =>
        resolveConsoleLaunchPlan({
          ...withoutDocker,
          dockerRuntimesUnreadable:
            "`docker info` exited 1: daemon is not running",
        }, OPTIONS)
      ).toThrow("daemon is not running");
    });

    it("returns the sidecar directories a separate-token registration names", () => {
      const plan = resolveConsoleLaunchPlan({
        ...RECORDS,
        dockerRuntimes: {
          "runsc-cfc": {
            runtimeArgs: [
              "-cfc-result-dir",
              "/store/results",
              "--cfc-invocation-context-dir",
              "/store/ctx",
            ],
          },
        },
      }, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/results",
      );
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR)
        .toBe("/store/ctx");
    });

    it("returns the last directory a registration names for a flag twice", () => {
      const plan = resolveConsoleLaunchPlan({
        ...RECORDS,
        dockerRuntimes: {
          "runsc-cfc": {
            runtimeArgs: [
              "--cfc-result-dir=/store/first",
              "--cfc-invocation-context-dir=/store/ctx",
              "--cfc-result-dir=/store/last",
            ],
          },
        },
      }, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/last",
      );
    });

    it("throws naming `--cfc-invocation-context-dir` when the registration omits it", () => {
      const records: ConsoleLaunchRecords = {
        ...RECORDS,
        dockerRuntimes: {
          "runsc-cfc": { runtimeArgs: ["--cfc-result-dir=/store/results"] },
        },
      };

      expect(() => resolveConsoleLaunchPlan(records, OPTIONS)).toThrow(
        "`--cfc-invocation-context-dir`",
      );
    });

    it("throws when an index is both named and waived", () => {
      expect(() =>
        resolveConsoleLaunchPlan(RECORDS, { ...OPTIONS, noPatternIndex: true })
      ).toThrow("contradict each other");
    });

    it("throws when a skills registry is both named and waived", () => {
      expect(() =>
        resolveConsoleLaunchPlan(RECORDS, {
          ...OPTIONS,
          noSkillsRegistry: true,
        })
      ).toThrow("contradict each other");
    });

    it("returns only variables `LAUNCHER_OWNED_VARIABLES` names", () => {
      // The launcher clears every owned variable before applying the resolved
      // ones, so a key it can set that is missing from that list would survive
      // from the operator's shell and contradict the printed report.

      const plans = [
        resolveConsoleLaunchPlan(RECORDS, {}),
        resolveConsoleLaunchPlan(RECORDS, {
          noPatternIndex: true,
          noSkillsRegistry: true,
        }),
        resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC),
      ];

      for (const plan of plans) {
        for (const key of Object.keys(plan.environment)) {
          expect(LAUNCHER_OWNED_VARIABLES).toContain(key);
        }
      }
    });

    it("returns the deployment's index and registry when neither is named", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {});

      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBe(
        DEPLOYMENT_PATTERN_INDEX_URL,
      );
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBe(
        DEPLOYMENT_SKILLS_REGISTRY_URL,
      );
    });

    it("returns the deployment default beside the source that says so", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, {});
      const index = plan.resolved.find((entry) => entry.name === "index");

      expect(index?.source).toBe("labs deployment default");
    });
  });

  // ----------------------------------------------------------------------
  // A fabric with no loom instance behind it
  //
  // The plain labs checkout, where nothing records the identity, the space,
  // the toolshed or the store, and the caller names all four.
  // ----------------------------------------------------------------------

  describe("resolveConsoleLaunchPlan() without an instance", () => {
    it("returns every value the caller named", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC);

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe("/keys/dev.key");
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("cf-harness-dev");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8000",
      );
      expect(plan.environment.MEMORY_DIR).toBe(
        "/checkout/packages/toolshed/cache/memory",
      );
    });

    it("returns a console directory naming the port alone", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, {
        ...NAMED_FABRIC,
        port: 8140,
      });

      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        ".cf-harness-console-8140",
      );
    });

    it("reports no instance among the resolved values", () => {
      const plan = resolveConsoleLaunchPlan(NO_INSTANCE, NAMED_FABRIC);

      expect(plan.resolved.some((entry) => entry.name === "instance")).toBe(
        false,
      );
    });

    it("throws naming `--fabric-identity` when the caller names none", () => {
      const { identity: _omitted, ...withoutIdentity } = NAMED_FABRIC;

      expect(() => resolveConsoleLaunchPlan(NO_INSTANCE, withoutIdentity))
        .toThrow("`--fabric-identity`");
    });

    it("throws naming `--store` when the caller names none", () => {
      const { store: _omitted, ...withoutStore } = NAMED_FABRIC;

      expect(() => resolveConsoleLaunchPlan(NO_INSTANCE, withoutStore))
        .toThrow("`--store`");
    });

    it("names no `pieces.json` in an error when no instance was read", () => {
      // The error text is what an operator acts on, and a plain labs checkout
      // has no loom instance to edit.

      const { space: _omitted, ...withoutSpace } = NAMED_FABRIC;

      expect(() => resolveConsoleLaunchPlan(NO_INSTANCE, withoutSpace))
        .toThrow(/^(?!.*pieces\.json).*$/s);
    });

    it("throws for a space named by DID, which composes no piece URL", () => {
      expect(() =>
        resolveConsoleLaunchPlan(NO_INSTANCE, {
          ...NAMED_FABRIC,
          space: "did:key:z6Mk",
        })
      ).toThrow("rather than a DID");
    });
  });

  describe("consoleLaunchReport()", () => {
    it("returns a line for every resolved value, each naming its source", () => {
      const plan = resolveConsoleLaunchPlan(RECORDS, OPTIONS);
      const lines = consoleLaunchReport(plan);

      for (const entry of plan.resolved) {
        expect(
          lines.some((line) =>
            line.includes(entry.value) && line.includes(entry.source)
          ),
        ).toBe(true);
      }
    });

    it("returns the space and store an operator checks the console against", () => {
      const lines = consoleLaunchReport(
        resolveConsoleLaunchPlan(RECORDS, OPTIONS),
      )
        .join("\n");

      expect(lines).toContain("ben-loom-dev-6");
      expect(lines).toContain(
        "/loom/instances/loom/toolshed-store/68239506e79d/",
      );
    });
  });
});
