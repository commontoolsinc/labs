/**
 * Worker-side runtime host for the multi-runtime harness.
 *
 * Each worker owns ONE full client stack — Identity, StorageManager, Runtime,
 * PiecesController — in its own JS realm, exactly like one browser tab. The
 * main thread orchestrates via a tiny request/response protocol.
 */

import type { Cell } from "@commonfabric/runner";
import type { SchedulerGraphSnapshot } from "@commonfabric/runner";
import { markUiInputBlindWriteTx } from "@commonfabric/runner";
import { markRendererTrustedEvent } from "@commonfabric/runner/cfc";
import { Identity, type KeyPairRaw } from "@commonfabric/identity";
import {
  type PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";

export interface WorkerRequest {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: unknown }
  | { id: number; error: string };

export interface TrustedUiDescriptor {
  /** `data-ui-pattern` / `data-ui-event-integrity` of the trusted surface. */
  surface: string;
  /** `data-ui-action` of the control inside the surface. */
  action: string;
}

export interface RuntimeDiagnosticsSnapshot {
  graph: SchedulerGraphSnapshot;
  settleStatsHistory: unknown[];
  actionRunTrace: unknown[];
}

let cc: PiecesController | undefined;
let piece: PieceController | undefined;
let resultSchema: unknown;
let resultSinkCancel: (() => void) | undefined;

function controller(): PiecesController {
  if (!cc) throw new Error("worker not initialized");
  return cc;
}

function currentPiece(): PieceController {
  if (!piece) throw new Error("no piece attached");
  return piece;
}

// Read through the pattern's declared result schema, like the UI does —
// schema defaults and scope annotations only apply on schema-aware reads.
function result(): Cell<any> {
  const raw = controller().manager().getResult(currentPiece().getCell());
  return resultSchema !== undefined ? raw.asSchema(resultSchema as never) : raw;
}

async function idle(): Promise<void> {
  await controller().manager().runtime.idle();
  await controller().manager().synced();
}

async function attachPiece(next: PieceController): Promise<void> {
  piece = next;
  resultSchema = (await next.getPattern() as { resultSchema?: unknown })
    .resultSchema;
  resultSinkCancel?.();
  // Keep the result graph subscribed so server pushes reach this runtime.
  resultSinkCancel = result().sink(() => {});
}

/**
 * Make `value` postMessage-safe: keep JSON data, drop functions/cells,
 * stringify bigints (JSON.stringify throws on them).
 */
function sanitizeForTransfer(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "function") return undefined;
    if (typeof entry === "bigint") return entry.toString();
    return entry;
  }));
}

const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  async init({ rawIdentity, spaceName, apiUrl, diagnostics }) {
    const identity = await Identity.deserialize(rawIdentity as KeyPairRaw);
    cc = await PiecesController.initialize({
      apiUrl: new URL(apiUrl as string),
      identity,
      spaceName: spaceName as string,
    });
    if (diagnostics === true) {
      const scheduler = controller().manager().runtime.scheduler;
      scheduler.enableSettleStats();
      scheduler.setActionRunTraceEnabled(true);
    }
    return { did: identity.did() };
  },

  async createPiece({ programPath, rootPath, input }) {
    const program = await controller().manager().runtime.harness.resolve(
      new FileSystemProgramResolver(
        programPath as string,
        rootPath as string,
      ),
    );
    const created = await controller().create(program, {
      input: isRecord(input) ? input : undefined,
      start: true,
    });
    await attachPiece(created);
    await idle();
    return { pieceId: created.id };
  },

  async openPiece({ pieceId }) {
    await attachPiece(await controller().get(pieceId as string, true));
    await idle();
    return {};
  },

  async send({ handler, event, trustedUi }) {
    const trusted = trustedUi as TrustedUiDescriptor | undefined;
    let eventValue: unknown = event ?? {};
    if (trusted) {
      // Equivalent of a genuine user interaction on a trusted surface: DOM
      // provenance plus the renderer-trusted mark the html worker reconciler
      // applies when delivering real DOM events.
      eventValue = {
        type: "click",
        ...(isRecord(event) ? event : {}),
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: trusted.surface,
            eventIntegrity: [trusted.surface],
            uiContractDataset: { uiAction: trusted.action },
          },
        },
      };
      markRendererTrustedEvent(eventValue);
    }
    const target = result();
    const { error } = await controller().manager().runtime.editWithRetry(
      (tx) => {
        target.key(handler as never).withTx(tx).send(eventValue as never);
      },
    );
    if (error) {
      throw new Error(`send "${handler}" failed: ${error.message}`);
    }
    await idle();
    return {};
  },

  // Faithful mirror of RuntimeProcessor.handleCellSet — the path a UI `$value`
  // binding takes: ONE fresh edit tx, a single un-retried commit. We additionally
  // await the commit so the test can observe the outcome (a conflict surfaces as
  // a Result error). Pass `idle: false` to leave this runtime un-settled, so its
  // local replica stays stale (needed for own-write-race / no-op repros).
  async set({ path, value, idle: doIdle }) {
    const runtime = controller().manager().runtime;
    const tx = runtime.edit();
    // Mirror the FIXED RuntimeProcessor.handleCellSet: a `$value` UI input is a
    // precondition-free LWW leaf write. Set CELLSET_NOFIX=1 to disable the fix
    // and observe the pre-fix own-write-race conflict + lost-edit behavior.
    let noFix = false;
    try {
      noFix = typeof Deno !== "undefined" &&
        Deno.env?.get?.("CELLSET_NOFIX") === "1";
    } catch { /* env not permitted; treat as fix-on */ }
    if (!noFix) markUiInputBlindWriteTx(tx);
    let cell = result();
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    cell.withTx(tx).set(value as never);
    runtime.prepareTxForCommit(tx);
    const res = await tx.commit() as { error?: { name?: string; message?: string } };
    if (doIdle !== false) await idle();
    return sanitizeForTransfer({
      ok: !res?.error,
      error: res?.error
        ? { name: res.error.name, message: res.error.message }
        : undefined,
    });
  },

  async read({ path }) {
    const target = result();
    await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    return sanitizeForTransfer(cell.get());
  },

  /**
   * Inspect the normalized link (id, space, scope) of a cell reached from
   * the piece result by `path`, resolving links along the way. Lets tests
   * assert the storage addressing (e.g. scope) of pattern state.
   */
  async link({ path }) {
    const target = result();
    await target.pull();
    let cell = target;
    for (const segment of (path ?? []) as (string | number)[]) {
      cell = cell.key(segment as never) as Cell<any>;
    }
    const resolved = cell.resolveAsCell();
    const link = resolved.getAsNormalizedFullLink();
    return sanitizeForTransfer({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path,
    });
  },

  async idle() {
    await idle();
    return {};
  },

  async diagnostics() {
    await idle();
    const scheduler = controller().manager().runtime.scheduler;
    return sanitizeForTransfer(
      {
        graph: scheduler.getGraphSnapshot(),
        settleStatsHistory: scheduler.getSettleStatsHistory(),
        actionRunTrace: scheduler.getActionRunTrace(),
      } satisfies RuntimeDiagnosticsSnapshot,
    );
  },

  async dispose() {
    resultSinkCancel?.();
    resultSinkCancel = undefined;
    piece = undefined;
    if (cc) {
      await cc.dispose();
      cc = undefined;
    }
    return {};
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = event.data;
  const handler = handlers[cmd];
  const respond = (response: WorkerResponse) =>
    (self as unknown as Worker).postMessage(response);
  if (!handler) {
    respond({ id, error: `unknown command "${cmd}"` });
    return;
  }
  handler(args).then(
    (ok) => respond({ id, ok }),
    (error: unknown) =>
      respond({
        id,
        error: error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      }),
  );
};
