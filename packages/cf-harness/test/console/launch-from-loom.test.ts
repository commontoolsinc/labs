import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  type LoomInstanceRecords,
  loomLaunchReport,
  resolveLoomLaunchPlan,
  runscCfcSidecarDirectories,
  WEAVER_PAIRING_PORT,
} from "../../console/launch-from-loom.ts";

const PIECES_JSON = JSON.stringify({
  defaults: {
    identity: "/keys/instance.key",
    local_space: "ben-loom-dev-6",
    server_urls: { toolshed: "http://localhost:8001" },
  },
});

const DOCKER_DAEMON_JSON = JSON.stringify({
  runtimes: {
    "runsc-cfc": {
      path: "/host_mnt/store/runsc-cfc/runsc",
      runtimeArgs: [
        "--cfc",
        "--cfc-result-dir=/host_mnt/store/runsc-cfc/sidecars/results",
        "--cfc-invocation-context-dir=/host_mnt/store/runsc-cfc/sidecars/ctx",
      ],
    },
  },
});

const RECORDS: LoomInstanceRecords = {
  piecesJson: PIECES_JSON,
  piecesJsonPath: "/loom/instances/loom/pieces.json",
  toolshedStoreDir: "file:///loom/instances/loom/toolshed-store/68239506e79d/",
  dockerDaemonJson: DOCKER_DAEMON_JSON,
  dockerDaemonJsonPath: "/home/.docker/daemon.json",
};

const OPTIONS = {
  instance: "loom",
  patternIndexUrl: "https://index.example",
  skillsRegistryUrl: "https://skills.example",
};

const withPieces = (
  defaults: Record<string, unknown>,
): LoomInstanceRecords => ({
  ...RECORDS,
  piecesJson: JSON.stringify({ defaults }),
});

describe("launch-from-loom", () => {
  describe("resolveLoomLaunchPlan()", () => {
    it("returns the identity, space and toolshed the instance records", () => {
      const plan = resolveLoomLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_FABRIC_IDENTITY).toBe(
        "/keys/instance.key",
      );
      expect(plan.environment.CF_HARNESS_FABRIC_SPACE).toBe("ben-loom-dev-6");
      expect(plan.environment.CF_HARNESS_FABRIC_API_URL).toBe(
        "http://localhost:8001",
      );
    });

    it("returns the store `loom toolshed-store-dir` printed as `MEMORY_DIR`", () => {
      const plan = resolveLoomLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.MEMORY_DIR).toBe(
        "file:///loom/instances/loom/toolshed-store/68239506e79d/",
      );
    });

    it("returns the sidecar directories the registered runtime names, as host paths", () => {
      const plan = resolveLoomLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_RUNSC_CFC_RESULT_DIR).toBe(
        "/store/runsc-cfc/sidecars/results",
      );
      expect(plan.environment.CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR).toBe(
        "/store/runsc-cfc/sidecars/ctx",
      );
    });

    it("returns the Weaver pairing port and a console directory naming it", () => {
      const plan = resolveLoomLaunchPlan(RECORDS, OPTIONS);

      expect(plan.environment.CF_HARNESS_CONSOLE_PORT).toBe(
        String(WEAVER_PAIRING_PORT),
      );
      expect(plan.environment.CF_HARNESS_CONSOLE_DIR).toBe(
        `.cf-harness-console-loom-${WEAVER_PAIRING_PORT}`,
      );
    });

    it("returns a distinct console directory for each port", () => {
      const first = resolveLoomLaunchPlan(RECORDS, { ...OPTIONS, port: 8136 });
      const second = resolveLoomLaunchPlan(RECORDS, { ...OPTIONS, port: 8137 });

      expect(first.environment.CF_HARNESS_CONSOLE_DIR).not.toBe(
        second.environment.CF_HARNESS_CONSOLE_DIR,
      );
    });

    it("returns the enforcing posture with flow labels persisted", () => {
      const plan = resolveLoomLaunchPlan(RECORDS, OPTIONS);

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
      const plan = resolveLoomLaunchPlan(RECORDS, {
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
      const plan = resolveLoomLaunchPlan(RECORDS, {
        instance: "loom",
        noPatternIndex: true,
        noSkillsRegistry: true,
      });

      expect(plan.environment.CF_HARNESS_PATTERN_INDEX_URL).toBeUndefined();
      expect(plan.environment.CF_HARNESS_SKILLS_REGISTRY_URL).toBeUndefined();
    });

    it("throws naming `defaults.identity` when the instance records none", () => {
      expect(() =>
        resolveLoomLaunchPlan(
          withPieces({
            local_space: "s",
            server_urls: { toolshed: "http://localhost:8001" },
          }),
          OPTIONS,
        )
      ).toThrow("`defaults.identity`");
    });

    it("throws naming `defaults.local_space` when the instance records none", () => {
      expect(() =>
        resolveLoomLaunchPlan(
          withPieces({
            identity: "/keys/instance.key",
            server_urls: { toolshed: "http://localhost:8001" },
          }),
          OPTIONS,
        )
      ).toThrow("`defaults.local_space`");
    });

    it("throws naming `defaults.server_urls.toolshed` when the instance records none", () => {
      expect(() =>
        resolveLoomLaunchPlan(
          withPieces({ identity: "/keys/instance.key", local_space: "s" }),
          OPTIONS,
        )
      ).toThrow("`defaults.server_urls.toolshed`");
    });

    it("throws naming the store command when loom printed no store", () => {
      expect(() =>
        resolveLoomLaunchPlan({ ...RECORDS, toolshedStoreDir: "" }, OPTIONS)
      ).toThrow("`loom toolshed-store-dir loom`");
    });

    it("throws naming `--cfc-result-dir` when no runtime registration names it", () => {
      const { dockerDaemonJson: _omitted, ...withoutDocker } = RECORDS;

      expect(() => resolveLoomLaunchPlan(withoutDocker, OPTIONS)).toThrow(
        "`--cfc-result-dir`",
      );
    });

    it("throws naming `--cfc-invocation-context-dir` when the registration omits it", () => {
      const records: LoomInstanceRecords = {
        ...RECORDS,
        dockerDaemonJson: JSON.stringify({
          runtimes: {
            "runsc-cfc": {
              runtimeArgs: ["--cfc-result-dir=/store/results"],
            },
          },
        }),
      };

      expect(() => resolveLoomLaunchPlan(records, OPTIONS)).toThrow(
        "`--cfc-invocation-context-dir`",
      );
    });

    it("throws naming `--pattern-index-url` when no index is named or waived", () => {
      expect(() =>
        resolveLoomLaunchPlan(RECORDS, {
          instance: "loom",
          skillsRegistryUrl: "https://skills.example",
        })
      ).toThrow("`--pattern-index-url`");
    });

    it("throws naming `--skills-registry-url` when no registry is named or waived", () => {
      expect(() =>
        resolveLoomLaunchPlan(RECORDS, {
          instance: "loom",
          patternIndexUrl: "https://index.example",
        })
      ).toThrow("`--skills-registry-url`");
    });
  });

  describe("runscCfcSidecarDirectories()", () => {
    it("returns nothing when the host registers no `runsc-cfc` runtime", () => {
      expect(
        runscCfcSidecarDirectories(
          JSON.stringify({ runtimes: { runc: {} } }),
          "/home/.docker/daemon.json",
        ),
      ).toEqual({});
    });

    it("returns a path a host-registered runtime names unchanged", () => {
      expect(
        runscCfcSidecarDirectories(
          JSON.stringify({
            runtimes: {
              "runsc-cfc": {
                runtimeArgs: [
                  "--cfc-result-dir=/var/lib/runsc-cfc/results",
                  "--cfc-invocation-context-dir=/var/lib/runsc-cfc/ctx",
                ],
              },
            },
          }),
          "/etc/docker/daemon.json",
        ),
      ).toEqual({
        resultDir: "/var/lib/runsc-cfc/results",
        invocationContextDir: "/var/lib/runsc-cfc/ctx",
      });
    });

    it("throws naming the file when it does not parse", () => {
      expect(() => runscCfcSidecarDirectories("{", "/home/.docker/daemon.json"))
        .toThrow("/home/.docker/daemon.json");
    });
  });

  describe("loomLaunchReport()", () => {
    it("returns a line for every resolved value, each naming its source", () => {
      const plan = resolveLoomLaunchPlan(RECORDS, OPTIONS);
      const lines = loomLaunchReport(plan);

      for (const entry of plan.resolved) {
        expect(
          lines.some((line) =>
            line.includes(entry.value) && line.includes(entry.source)
          ),
        ).toBe(true);
      }
    });

    it("returns the space and store an operator checks the console against", () => {
      const lines = loomLaunchReport(resolveLoomLaunchPlan(RECORDS, OPTIONS))
        .join("\n");

      expect(lines).toContain("ben-loom-dev-6");
      expect(lines).toContain(
        "/loom/instances/loom/toolshed-store/68239506e79d/",
      );
    });
  });
});
