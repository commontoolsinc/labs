/**
 * Pins the schema/value alignment of the argument scheduler-read collector
 * (`collectArgumentSchedulerReadLinks`): write-redirect links bound in tuple
 * (prefixItems) slot positions must be visited like `items`-covered elements
 * (CT-1895 — prefixItems-only schemas previously skipped array elements
 * entirely, so links bound in tuple positions escaped scheduler read
 * tracking).
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("argument scheduler read links");
const space = signer.did();

describe("argument scheduler read links", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const collect = (
    argumentSchema: unknown,
    value: unknown,
    resultCell: unknown,
  ): NormalizedFullLink[] =>
    // deno-lint-ignore no-explicit-any
    (runtime.runner as any).collectArgumentSchedulerReadLinks(
      argumentSchema,
      value,
      resultCell,
    );

  it("visits tuple (prefixItems) slot elements", () => {
    const resultCell = runtime.getCell(space, "sched-read-result");
    const sourceCell = runtime.getCell<number>(space, "sched-read-source");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "number" }],
        },
      },
    };
    const value = {
      route: [sourceCell.getAsWriteRedirectLink({ base: resultCell })],
    };

    const links = collect(argumentSchema, value, resultCell);
    expect(links.length).toBe(1);
    expect(links[0].id).toBe(sourceCell.getAsNormalizedFullLink().id);
  });

  it("visits items-covered elements past the tuple slots", () => {
    // Parity pin: the rest region keeps its pre-existing items coverage.
    const resultCell = runtime.getCell(space, "sched-read-rest-result");
    const sourceCell = runtime.getCell<number>(space, "sched-read-rest-src");
    const argumentSchema = {
      type: "object",
      properties: {
        route: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "number" },
        },
      },
    };
    const value = {
      route: ["label", sourceCell.getAsWriteRedirectLink({ base: resultCell })],
    };

    const links = collect(argumentSchema, value, resultCell);
    expect(links.length).toBe(1);
    expect(links[0].id).toBe(sourceCell.getAsNormalizedFullLink().id);
  });
});
