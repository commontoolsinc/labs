import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  getRegistration,
  type IngestRegistration,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import {
  collectRows,
  defaultRuntime as auditRuntime,
  main as auditMain,
  render,
  runAudit,
} from "./audit-ingest-channels.ts";
import {
  defaultRuntime as retireRuntime,
  main as retireMain,
  retireChannels,
  runRetire,
  USAGE,
} from "./retire-ingest-channels.ts";

// The two operator scripts behind the retirement procedure. They are the only
// tooling that makes a trust-condition cutover answerable, so the selection
// logic — what gets retired, what is skipped, what the audit reports — is worth
// pinning even though the entrypoints themselves are thin.

describe("ingest channel operator scripts", () => {
  let signer: Identity;
  let serviceSpace: string;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const reg = (over: Partial<IngestRegistration> = {}): IngestRegistration => ({
    id: "ing_a",
    name: "a",
    space: "did:key:z6MkspaceAAAA",
    causePrefix: "location",
    installId: "phone-1",
    sink: "journal",
    secretHash: "hash",
    createdBy: serviceSpace,
    createdAt: "2026-08-01T00:00:00.000Z",
    enabled: true,
    ...over,
  });

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("ingest-scripts-test");
    serviceSpace = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://scripts-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("audits every registered channel, with owner and state", async () => {
    await saveRegistration(runtime, serviceSpace, reg({ owner: "did:key:zA" }));
    await saveRegistration(
      runtime,
      serviceSpace,
      reg({
        id: "ing_b",
        installId: "phone-2",
        enabled: false,
        revoked: { at: "2026-08-02T00:00:00.000Z", by: "did:key:zA" },
      }),
    );

    const rows = await collectRows(runtime, serviceSpace);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === "ing_a")?.state).toBe("active");
    expect(rows.find((r) => r.id === "ing_b")?.state).toBe("revoked");
    expect(rows.find((r) => r.id === "ing_b")?.revokedAt).toBe(
      "2026-08-02T00:00:00.000Z",
    );
  });

  // Operator-provisioned channels have no verified owner, and they are exactly
  // the ones no user can revoke for themselves — so the audit must name them.
  it("marks a channel with no verified owner", async () => {
    await saveRegistration(runtime, serviceSpace, reg());
    const rows = await collectRows(runtime, serviceSpace);
    expect(rows[0].owner).toBe("<operator-provisioned>");
  });

  it("renders both human and JSON output", async () => {
    await saveRegistration(runtime, serviceSpace, reg({ owner: "did:key:zA" }));
    const rows = await collectRows(runtime, serviceSpace);

    const human = render(rows, false).join("\n");
    expect(human).toContain("ing_a");
    expect(human).toContain("1 channel(s), 1 active.");

    const json = JSON.parse(render(rows, true).join("\n"));
    expect(json.channels[0].id).toBe("ing_a");

    expect(render([], false).join("\n")).toContain("none.");
  });

  it("retires nothing unless confirmed", async () => {
    await saveRegistration(runtime, serviceSpace, reg());

    const dry = await retireChannels(runtime, serviceSpace, { reason: "why" });
    expect(dry.retired.length).toBe(1);

    // Dry run means dry: the registration is untouched.
    const stored = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(stored?.enabled).toBe(true);
    expect(stored?.revoked).toBeUndefined();
  });

  it("retires with an attributable reason when confirmed", async () => {
    await saveRegistration(runtime, serviceSpace, reg());

    const done = await retireChannels(runtime, serviceSpace, {
      reason: "space-key-derivation-fix",
      confirm: true,
      now: new Date("2026-08-05T00:00:00.000Z"),
    });
    expect(done.retired.length).toBe(1);

    const stored = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(stored?.enabled).toBe(false);
    // An operator retirement must stay distinguishable from a user's own
    // revoke in the trail.
    expect(stored?.revoked?.by).toBe("operator:space-key-derivation-fix");
    expect(stored?.revoked?.at).toBe("2026-08-05T00:00:00.000Z");
  });

  it("skips channels that are already revoked, and is idempotent", async () => {
    await saveRegistration(runtime, serviceSpace, reg());
    await retireChannels(runtime, serviceSpace, {
      reason: "first",
      confirm: true,
    });

    // Re-running is the documented remedy for the non-atomic window, so it has
    // to be safe: nothing retired again, and the original reason preserved.
    const again = await retireChannels(runtime, serviceSpace, {
      reason: "second",
      confirm: true,
    });
    expect(again.retired.length).toBe(0);
    expect(again.skipped).toBe(1);
    expect((await getRegistration(runtime, serviceSpace, "ing_a"))?.revoked?.by)
      .toBe("operator:first");
  });

  // A rotate that read the registration before the sweep reached it must not
  // still satisfy its own precondition afterwards and undo the retirement.
  it("advances the revision so a stale write cannot undo a retirement", async () => {
    await saveRegistration(runtime, serviceSpace, reg());
    const stale = await getRegistration(runtime, serviceSpace, "ing_a");

    await retireChannels(runtime, serviceSpace, {
      reason: "cutover",
      confirm: true,
    });

    await expect(
      saveRegistration(
        runtime,
        serviceSpace,
        { ...stale!, enabled: true, revision: (stale!.revision ?? 0) + 1 },
        stale!.revision ?? 0,
      ),
    ).rejects.toThrow();

    const after = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(after?.enabled).toBe(false);
    expect(after?.revoked?.by).toBe("operator:cutover");
  });

  it("scopes to one space when asked", async () => {
    await saveRegistration(runtime, serviceSpace, reg());
    await saveRegistration(
      runtime,
      serviceSpace,
      reg({ id: "ing_b", space: "did:key:z6MkspaceBBBB" }),
    );

    const plan = await retireChannels(runtime, serviceSpace, {
      reason: "scoped",
      space: "did:key:z6MkspaceBBBB",
      confirm: true,
    });
    expect(plan.retired.map((r) => r.id)).toEqual(["ing_b"]);
    expect((await getRegistration(runtime, serviceSpace, "ing_a"))?.enabled)
      .toBe(true);
  });

  it("runAudit renders the whole command output", async () => {
    await saveRegistration(runtime, serviceSpace, reg({ owner: "did:key:zA" }));
    expect((await runAudit(runtime, serviceSpace, {})).join("\n")).toContain(
      "1 channel(s), 1 active.",
    );
    const json = JSON.parse(
      (await runAudit(runtime, serviceSpace, { json: true })).join("\n"),
    );
    expect(json.channels.length).toBe(1);
  });

  it("runRetire reports a dry run and a confirmed run differently", async () => {
    await saveRegistration(runtime, serviceSpace, reg());

    const dry = (await runRetire(runtime, serviceSpace, { reason: "r" }))
      .join("\n");
    expect(dry).toContain("would retire  ing_a");
    expect(dry).toContain("Would retire 1 channel(s); 0 already revoked.");
    expect(dry).toContain("Dry run — nothing written.");

    const done = (await runRetire(runtime, serviceSpace, {
      reason: "r",
      confirm: true,
    })).join("\n");
    expect(done).toContain("retiring  ing_a");
    expect(done).toContain("Retired 1 channel(s)");
    // The confirmed run has to tell the operator what owners do next.
    expect(done).toContain("cf ingest mint");
  });

  it("the usage text names the flag that makes the trail meaningful", () => {
    expect(USAGE).toContain("--reason");
    expect(USAGE).toContain("space-key-derivation-fix");
  });

  // The command entrypoints: argv parsing, the exit code, and the output sink.
  // Each gets its OWN runtime because `main` disposes what it is handed, and a
  // spread copy is not an option — `Runtime` reads private class fields.
  describe("entrypoints", () => {
    const freshRuntime = async () => {
      const owner = await Identity.fromPassphrase(
        `entrypoint-${crypto.randomUUID()}`,
      );
      const sm = StorageManager.emulate({ as: owner });
      const rt = new Runtime({
        apiUrl: new URL("https://scripts-entry.invalid"),
        storageManager: sm,
      });
      return { rt, space: owner.did() };
    };

    // The factory each script uses when nobody injects one. Constructing it
    // opens no connection — sessions are created lazily on first space access —
    // so this stays a unit test while still pinning that the wiring is valid.
    it("the default runtime factories construct and dispose cleanly", async () => {
      for (const make of [auditRuntime, retireRuntime]) {
        const rt = make();
        await rt.dispose();
      }
    });

    it("audit main parses --json and exits 0", async () => {
      const { rt, space } = await freshRuntime();
      await saveRegistration(rt, space, reg({ owner: "did:key:zA" }));
      const lines: string[] = [];
      expect(
        await auditMain(["--json"], () => rt, space, (l) => lines.push(l)),
      ).toBe(0);
      expect(JSON.parse(lines.join("\n")).channels.length).toBe(1);
    });

    // The reason is what makes the audit trail say WHY, so omitting it must not
    // quietly retire everything with a blank attribution.
    it("retire main refuses without --reason and prints usage", async () => {
      const { rt, space } = await freshRuntime();
      const errors: string[] = [];
      expect(
        await retireMain([], () => rt, space, () => {}, (l) => errors.push(l)),
      ).toBe(2);
      expect(errors.join("\n")).toContain("--reason");
      await rt.dispose();
    });

    it("retire main is a dry run by default and writes with --confirm", async () => {
      const dry = await freshRuntime();
      await saveRegistration(dry.rt, dry.space, reg());
      const lines: string[] = [];
      expect(
        await retireMain(
          ["--reason", "why"],
          () => dry.rt,
          dry.space,
          (l) => lines.push(l),
        ),
      ).toBe(0);
      expect(lines.join("\n")).toContain("Dry run — nothing written.");

      const wet = await freshRuntime();
      await saveRegistration(wet.rt, wet.space, reg());
      expect(
        await retireMain(
          ["--reason", "why", "--confirm"],
          () => wet.rt,
          wet.space,
          () => {},
        ),
      ).toBe(0);
    });
  });

  // Values read back from a cell are deep-frozen and do not round-trip when
  // spread into a new object, so the history has to be rebuilt to survive a
  // second retirement.
  it("preserves revocation history across a retire cycle", async () => {
    await saveRegistration(
      runtime,
      serviceSpace,
      reg({
        revocations: [{ at: "2026-07-01T00:00:00.000Z", by: "did:key:zA" }],
      }),
    );
    await retireChannels(runtime, serviceSpace, {
      reason: "keeps-history",
      confirm: true,
    });

    const stored = await getRegistration(runtime, serviceSpace, "ing_a");
    expect(stored?.revocations?.length).toBe(1);
    expect(stored?.revocations?.[0].by).toBe("did:key:zA");
  });
});
