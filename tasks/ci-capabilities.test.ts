import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  BINARY_CACHE_DIR,
  CAPABILITIES,
  type CapabilityId,
  openCapabilities,
  pidOfBackgroundLaunch,
  resolveCapabilities,
} from "./ci-capabilities.ts";

describe("ci capabilities", () => {
  it("opens what a capability is built on before the capability", () => {
    const order = resolveCapabilities(["toolshed"]);
    expect(order.indexOf("deno")).toBeLessThan(order.indexOf("toolshed"));
  });

  it("opens each capability once however many suites asked for it", () => {
    const order = resolveCapabilities(["toolshed", "cf", "toolshed", "deno"]);
    expect(order.length).toBe(new Set(order).size);
    expect(order.filter((id) => id === "deno").length).toBe(1);
  });

  it("comes to the same order whatever order the requests arrived in", () => {
    const one = resolveCapabilities(["browser", "cf", "jq", "toolshed"]);
    const other = resolveCapabilities(["toolshed", "jq", "cf", "browser"]);
    expect(one).toEqual(other);
  });

  it("refuses a capability nothing declares", () => {
    expect(() => resolveCapabilities(["invented" as CapabilityId])).toThrow(
      "no such capability",
    );
  });

  it("declares only capabilities that are built on declared ones", () => {
    for (const capability of CAPABILITIES.values()) {
      for (const need of capability.needs ?? []) {
        expect(
          [capability.id, CAPABILITIES.has(need)],
        ).toEqual([capability.id, true]);
      }
    }
  });

  it("keys every capability by its own identifier", () => {
    for (const [id, capability] of CAPABILITIES) {
      expect(capability.id).toBe(id);
    }
  });

  it("exports the environment a dry run's batches would see", async () => {
    const opened = await openCapabilities(["toolshed"], {
      root: Deno.cwd(),
      dryRun: true,
      workDir: "/nonexistent",
    });
    expect(opened.env.API_URL).toBe("http://localhost:8000/");
    expect(opened.timings.map((timing) => timing.capability)).toEqual([
      "deno",
      "toolshed",
    ]);
    await opened.close();
  });

  it("closes what it opened when a later capability fails", async () => {
    const closed: string[] = [];
    const registry = new Map(CAPABILITIES);
    registry.set("cf", {
      id: "cf",
      description: "a capability that closes when told",
      open: () =>
        Promise.resolve({
          env: {},
          close: () => {
            closed.push("cf");
            return Promise.resolve();
          },
        }),
    });
    registry.set("jq", {
      id: "jq",
      description: "a capability that cannot open",
      // Ordered after `cf` by the alphabetical walk, so `cf` is already
      // open when this one fails.
      open: () => Promise.reject(new Error("no jq here")),
    });
    await expect(
      openCapabilities(["cf", "jq"], {
        root: Deno.cwd(),
        dryRun: true,
        workDir: "/nonexistent",
      }, registry),
    ).rejects.toThrow("no jq here");
    expect(closed).toEqual(["cf"]);
  });

  it("keeps a built binary where the workflow's cache step looks", () => {
    // The lane's own working directory is made fresh every run, so a
    // binary kept there would be rebuilt every time however well the
    // cache step worked. The path has to be one the workflow also names.
    expect(BINARY_CACHE_DIR).toBe(".ci-cache/binaries");
  });

  it("reads the process a background launch detached", () => {
    expect(
      pidOfBackgroundLaunch(
        "Toolshed is listening; the server is running in the background " +
          "(pid 4213). Logs: /tmp/toolshed.log",
      ),
    ).toBe(4213);
    expect(pidOfBackgroundLaunch("no process here")).toBeUndefined();
  });
});
