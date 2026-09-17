import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  consolePatternIndexHealthProbes,
  consoleSandboxHealthProbe,
} from "../../console/health-probes.ts";
import { ConsoleHealth } from "../../console/health.ts";
import { PatternIndexClient } from "../../src/pattern-index/client.ts";

const signer = await Identity.fromPassphrase("console health observations");

describe("health-probes", () => {
  describe("consoleSandboxHealthProbe()", () => {
    for (const registered of [true, false]) {
      it(`reports Docker responding with runsc-cfc ${registered ? "registered" : "missing"}`, async () => {
        const probe = consoleSandboxHealthProbe(() =>
          Promise.resolve({
            runtimes: registered ? { "runsc-cfc": {} } : { runc: {} },
          })
        );
        const rows = await probe.read();
        expect(rows.map(({ id, state, value }) => ({ id, state, value })))
          .toEqual([
            { id: "sandbox.docker", state: "ok", value: "responding" },
            {
              id: "sandbox.runtime",
              state: registered ? "ok" : "failed",
              value: registered
                ? "runsc-cfc registered"
                : "runsc-cfc not registered",
            },
          ]);
        expect(rows.every((row) => Number.isFinite(Date.parse(row.checkedAt!))))
          .toBe(true);
        expect(rows[1]).toMatchObject({
          label: "Sandbox Runtime",
          source: "docker info",
          detail: "docker info --format '{{json .Runtimes}}'",
        });
        expect(rows[1].remedy).toBe(
          registered
            ? undefined
            : "Install the runsc-cfc runtime and reload Docker's runtime registration.",
        );
      });
    }

    for (const runtimes of [undefined, null, [], "invalid"]) {
      it(`leaves availability unknown for ${JSON.stringify(runtimes)} runtime metadata`, async () => {
        const probe = consoleSandboxHealthProbe(() =>
          Promise.resolve({ runtimes, unreadable: "daemon unavailable" })
        );
        const rows = await probe.read();
        expect(rows.map((row) => [row.state, row.reason])).toEqual([
          ["unknown", "daemon unavailable"],
          ["unknown", "daemon unavailable"],
        ]);
      });
    }
  });

  describe("consolePatternIndexHealthProbes()", () => {
    for (const suffix of ["", "?token=query-secret#fragment-secret"]) {
      it(`omits URL credentials from diagnostics with suffix ${JSON.stringify(suffix)}`, async () => {
        const baseUrl =
          `https://user-secret:password-secret@index.test/api/${suffix}`;
        const health = new ConsoleHealth(
          [],
          consolePatternIndexHealthProbes(
            baseUrl,
            () =>
              Promise.resolve(
                new PatternIndexClient({
                  signer,
                  baseUrl,
                  fetchFn: () =>
                    Promise.resolve(Response.json({
                      ok: false,
                      did: signer.did(),
                      enrolled: false,
                    })),
                }),
              ),
          ),
        );
        expect(JSON.stringify(health.snapshot())).not.toContain("-secret");
        await health.refresh();
        const rows = health.snapshot().rows;
        expect(rows[1]).toMatchObject({
          state: suffix === "" ? "failed" : "unknown",
          detail:
            "GET enrollmentStatus at https://index.test/api/, for the console identity",
          remedy: suffix === ""
            ? "Enroll the console's identity through https://index.test/api/enroll."
            : "Check the configured index URL, network access, and console identity file.",
        });
        expect(JSON.stringify(rows)).not.toContain("-secret");
      });
    }

    it("uses independent read-only endpoints and the console identity under the configured prefix", async () => {
      const requests: Request[] = [];
      const client = new PatternIndexClient({
        signer,
        baseUrl: "https://index.test/api/",
        fetchFn: (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Promise.resolve(
            Response.json(
              new URL(request.url).pathname.endsWith("/health")
                ? { ok: true }
                : { did: signer.did(), enrolled: true },
            ),
          );
        },
      });
      const probes = consolePatternIndexHealthProbes(
        "https://index.test/api/",
        () => Promise.resolve(client),
      );
      const health = new ConsoleHealth([], probes);
      await health.refresh();
      expect(
        requests.map((request) => [request.method, request.url, request.body]),
      ).toEqual([
        ["GET", "https://index.test/api/health", null],
        [
          "GET",
          `https://index.test/api/enrollmentStatus?did=${
            encodeURIComponent(signer.did())
          }`,
          null,
        ],
      ]);
      expect(
        health.snapshot().rows.map((row) => [row.id, row.state, row.value]),
      ).toEqual([
        ["index.reachable", "ok", "responding"],
        ["index.enrolled", "ok", "console identity enrolled"],
      ]);
      expect(health.snapshot().rows[0]).toMatchObject({
        label: "Pattern Index Reachability",
        source: "index /health",
        detail: "GET health at https://index.test/api/",
      });
    });

    for (
      const testCase of [
        {
          body: { did: signer.did(), enrolled: false },
          state: "failed",
          value: "console identity not enrolled",
        },
        {
          body: { did: "did:key:someone-else", enrolled: true },
          state: "unknown",
          value: "not verified",
        },
        {
          body: { did: signer.did(), enrolled: "true" },
          state: "unknown",
          value: "not verified",
        },
        { body: [], state: "unknown", value: "not verified" },
      ]
    ) {
      it(`reports ${testCase.state} for enrollment response ${JSON.stringify(testCase.body)}`, async () => {
        const client = new PatternIndexClient({
          signer,
          baseUrl: "https://index.test",
          fetchFn: () => Promise.resolve(Response.json(testCase.body)),
        });
        const probe =
          consolePatternIndexHealthProbes("https://index.test", () =>
            Promise.resolve(client))[1];
        const rows = await probe.read();
        expect(rows[0]).toMatchObject({
          state: testCase.state,
          value: testCase.value,
        });
        expect(rows[0].remedy).toEqual(expect.any(String));
      });
    }

    it("preserves an HTTP failure's status without copying its response body into operator diagnostics", async () => {
      const client = new PatternIndexClient({
        signer,
        baseUrl: "https://index.test",
        fetchFn: () =>
          Promise.resolve(
            Response.json({ error: "private diagnostic" }, { status: 503 }),
          ),
      });
      const health = new ConsoleHealth(
        [],
        consolePatternIndexHealthProbes(
          "https://index.test",
          () => Promise.resolve(client),
        ),
      );
      await health.refresh();
      const rows = health.snapshot().rows;
      expect(rows.map((row) => row.state)).toEqual(["unknown", "unknown"]);
      expect(rows.every((row) => row.reason?.includes("HTTP 503"))).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("private diagnostic");
    });
  });
});
