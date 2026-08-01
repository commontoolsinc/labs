import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { toolshedRuntimeOptions } from "@/runtime-options.ts";

/**
 * THE BEHAVIOURAL PIN behind toolshed's `externalSinkDisposition: "suppress"`
 * declaration (`runtime-options.ts`). The declaration itself is asserted in
 * `runtime-options.test.ts`; this file asserts what the declaration DOES, and
 * — just as importantly — what it must NOT do.
 *
 * Why it exists. A webhook delivery does not merely write a cell. The
 * scheduler finds no local handler for the inbox stream, calls
 * `ensurePieceRunning`, LOADS THE PATTERN AND STARTS THE PIECE inside the API
 * server process, and then runs the piece's reactive graph — effect builtins
 * included. So toolshed's Runtime is an unrestricted pattern runtime reachable
 * from a plain stream write. When this file was written, a runtime that
 * declared nothing egressed on the client default (`"claim-conditional"` → no
 * server effect claim → `"allow"`), and toolshed's declaration was the only
 * thing standing between a stream write and the outside world. The terminal
 * flip has since made `"suppress"` the default, so the declaration is now a
 * statement of posture rather than the sole barrier — but it is still the
 * BEHAVIOUR, not the default, that this file pins.
 *
 * The trap this file guards. The tempting alternative — stop toolshed starting
 * the piece at all (`doNotLoadPieceIfNotRunning`) — fails SILENTLY: the local
 * start IS the runner's demand publication (`runner.ts`, `start()` →
 * `addExecutionDemand`), so suppressing the start publishes no demand, no
 * executor becomes live for the space, and the webhook event lands durably and
 * NOTHING ever runs it. A missing side effect is worse than a duplicated one,
 * so both arms are asserted together: the piece must still start and the
 * handler must still run, AND the sink must be recorded-but-never-released.
 *
 * THE CONTROL ARM IS LOAD-BEARING. Without it a zero-egress assertion passes
 * for the wrong reason (piece never started / handler never ran / url never
 * set). The control runs the identical topology on a runtime that MAY egress
 * and REQUIRES the release to happen. It used to obtain that runtime by
 * STRIPPING the declaration; the flip retired that route — a stripped runtime
 * is now suppressed, so the control would have certified the fixture live
 * while measuring nothing at all. It declares `"server-executor"` instead,
 * which is the posture, not the absence of one.
 */

/**
 * A webhook-shaped consumer: an inbox stream whose handler writes a url, and
 * an EFFECT builtin downstream of that write. `Default<''>` keeps the seed run
 * egress-free (`fetch.ts` returns early on an empty url), so every fetch this
 * test observes is caused by the webhook delivery.
 */
const WEBHOOK_EGRESS_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "/// <cts-enable />",
      "import { Default, fetchText, handler, pattern, Writable } from 'commonfabric';",
      "",
      "const onWebhookEvent = handler<",
      "  { url: string },",
      "  { target: Writable<string> }",
      ">((event, { target }) => {",
      "  target.set(event.url);",
      "});",
      "",
      "export default pattern<{",
      "  target: Writable<string | Default<''>>;",
      "}>(({ target }) => ({",
      "  target,",
      "  inbox: onWebhookEvent({ target }),",
      "  fetched: fetchText({ url: target }),",
      "}));",
    ].join("\n"),
  }],
};

const DOWNSTREAM_URL = "https://webhook-downstream.invalid/notify";

const TOOLSHED_CONFIG = {
  MEMORY_URL: "https://memory.invalid/",
  API_URL: "https://api.invalid/",
} as const;

type ArmResult = {
  /** What `toolshedRuntimeOptions` itself declares, before any override. */
  readonly declared: unknown;
  /** Did `ensurePieceRunning` start the piece and did its handler run? */
  readonly handlerRan: boolean;
  /** Urls that reached the runtime's network seam — i.e. sinks RELEASED. */
  readonly fetched: readonly string[];
};

/**
 * One arm. `override` is applied on top of the real production options:
 * `"verbatim"` keeps them untouched, `"strip"` removes the declaration so the
 * runtime falls to the constructor default, and a policy value declares one
 * explicitly.
 */
const runWebhookArm = async (
  label: string,
  override: "verbatim" | "strip" | "suppress" | "server-executor",
): Promise<ArmResult> => {
  const signer = await Identity.fromPassphrase(
    `toolshed webhook egress authority ${label}`,
  );
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const options = toolshedRuntimeOptions(
    TOOLSHED_CONFIG,
    storageManager,
    () => undefined,
  );
  const declared = options.externalSinkDisposition;
  const {
    externalSinkDisposition: _stripped,
    ...withoutDeclaration
  } = options;
  const fetched: string[] = [];
  const runtime = new Runtime({
    ...(override === "strip" ? withoutDeclaration : options),
    ...(override === "suppress" || override === "server-executor"
      ? { externalSinkDisposition: override }
      : {}),
    // The network seam a released sink reaches (`runtime.fetchBuiltin` falls
    // through to `runtime.fetch` for a runtime with no builtin broker). This
    // is the ONLY substitution: the disposition under test is untouched.
    fetch: (input: RequestInfo | URL) => {
      fetched.push(typeof input === "string" ? input : input.toString());
      return Promise.resolve(
        new Response("{}", { headers: { "content-type": "application/json" } }),
      );
    },
  });

  try {
    const compiled = await runtime.patternManager.compilePattern(
      WEBHOOK_EGRESS_PROGRAM,
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<Record<string, unknown>>(
      space,
      `webhook-egress-${label}`,
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, {}, result);
    runtime.prepareTxForCommit(tx);
    assertEquals((await tx.commit()).error, undefined);
    await handle.pull();
    await runtime.settled();
    await runtime.storageManager.synced();
    // The seed run must be egress-free — otherwise the post-webhook count
    // below would not attribute cleanly to the delivery.
    assertEquals(fetched, [], `${label}: the seed run egressed`);

    // Put the piece back in the state a fresh toolshed process finds it in:
    // present in storage, NOT running, no local handler for the inbox.
    runtime.runner.stop(result);
    await runtime.idle();

    // The delivery, exactly as `sendToStream` performs it: resolve the link,
    // re-read it as a stream, `send` inside `editWithRetry`.
    const inboxLink = result.key("inbox").getAsNormalizedFullLink();
    const streamCell = runtime
      .getCellFromLink(inboxLink)
      .asSchema({ asCell: ["stream"] });
    await streamCell.sync();
    await runtime.storageManager.synced();
    const { error } = await runtime.editWithRetry((etx) => {
      streamCell.withTx(etx).send({ url: DOWNSTREAM_URL });
    });
    assertEquals(error, undefined, `${label}: the webhook send failed`);

    // `ensurePieceRunning` is async off the scheduler's event queue, and the
    // effect builtin's release is a post-commit continuation, so drive both to
    // quiescence rather than a single idle().
    for (let i = 0; i < 6; i++) {
      await runtime.idle();
      await runtime.settled();
      await runtime.storageManager.synced();
    }

    return {
      declared,
      handlerRan: result.key("target").get() === DOWNSTREAM_URL,
      fetched: [...fetched],
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

// THE CONTROL, and the fact that retired its previous form. Both arms run the
// identical topology and differ only in the declared posture, so read them as
// a pair: an egress-capable toolshed runtime DOES release the webhook's sink,
// and a runtime that declares nothing does NOT.
//
// The second arm is what the control used to BE. It was written when declaring
// nothing meant "claim-conditional" and therefore egress, so stripping the
// declaration was how the fixture proved itself live. The terminal flip
// inverted that, and the failure mode is the quiet one: strip-as-control would
// still have "passed" the day the flip landed, certifying a fixture that could
// not egress under any circumstances. Keeping the stripped arm here — asserting
// the opposite of what it once asserted — is what makes the reversal visible
// rather than merely absent.
Deno.test("a webhook delivery into a not-running piece egresses from toolshed's process only when the runtime declares egress authority", async () => {
  const authorized = await runWebhookArm("control", "server-executor");
  assertEquals(
    authorized.handlerRan,
    true,
    "the webhook never started the piece",
  );
  assertEquals(authorized.fetched, [DOWNSTREAM_URL]);

  const stripped = await runWebhookArm("stripped", "strip");
  assertEquals(
    stripped.handlerRan,
    true,
    "the webhook never started the piece",
  );
  assertEquals(
    stripped.fetched,
    [],
    "a runtime that declares nothing must not egress",
  );
});

// The behaviour the pin buys, asserted independently of where the value comes
// from: suppression must remove the EGRESS without removing the local start.
// If a future change makes `"suppress"` also suppress the start, this arm goes
// red on `handlerRan` — which is the option-(c) trap firing.
Deno.test("a suppress-declared toolshed runtime still starts the webhook's piece and runs its handler, but never releases the sink", async () => {
  const arm = await runWebhookArm("declared-suppress", "suppress");
  assertEquals(arm.handlerRan, true, "suppression also suppressed the start");
  assertEquals(arm.fetched, []);
});

// The production wiring itself, end to end: no override at all.
Deno.test("toolshed's production runtime options suppress the webhook piece's egress", async () => {
  const arm = await runWebhookArm("production", "verbatim");
  assertEquals(arm.handlerRan, true, "suppression also suppressed the start");
  assertEquals(arm.fetched, []);
  assertEquals(arm.declared, "suppress");
});
