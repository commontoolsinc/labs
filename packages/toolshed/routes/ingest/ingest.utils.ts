import type { JSONSchema, MemorySpace, Runtime } from "@commonfabric/runner";
import {
  custodyIngest,
  durableSet,
  type VouchedChannel,
} from "@/lib/custody-ingest.ts";
import { sha256 } from "@/lib/sha2.ts";

// The `journal` sink of a vouched ingest channel: a durable, append-only,
// ExternalIngest-marked record log. This is the generic capability — location
// is one consumer of it (its beacon POSTs `location.point` records; loom wraps
// them into `loom.source-record.v1` envelopes on READ). Nothing here knows about
// location or loom's schema; records are stored verbatim and the read side is
// the single schema authority.
//
// Iteration 1 is deliberately provisioning-only-out-of-band: this module has NO
// self-serve create/list/delete. Channels are minted by an operator command
// (scripts/provision-ingest-channel.ts) which writes the registration; the only
// HTTP surface is ingest. Self-serve creation (gated on real caller auth) is the
// additive "make it generic/self-serve later" step. All registry helpers take
// `runtime` explicitly so the operator script can reuse them without booting the
// server. See docs/development/proposals/ingest-channels-journal-sink.md.

const INGEST_ID_LENGTH = 20;
const INGEST_SECRET_BYTES = 32;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Max records accepted in one POST (on top of the 1 MB body limit). */
export const MAX_BATCH = 1000;

// A single clean cause segment. Used for BOTH halves of the cell cause
// `${causePrefix}/${partition}`. Charset + length bounded, and never `.`/`..`
// (which pass the charset but would address a cell loom's date enumerator never
// reads — a silent write-to-nowhere). NOT a security boundary: the write is
// always confined to the channel's registered space + causePrefix regardless of
// the value — this is a shape contract so labs and loom derive the same cell id.
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const isValidSegment = (s: string): boolean =>
  SEGMENT_RE.test(s) && s !== "." && s !== "..";
export const isValidPartition = isValidSegment;

export interface IngestRegistration {
  id: string;
  name: string;
  /** The space partition cells are written into (the end user's space). */
  space: string;
  /** Cell-cause prefix; a partition cell's cause is `${causePrefix}/${partition}`. */
  causePrefix: string;
  /** Stable source identifier: recorded on the mark + the cross-repo join key. */
  installId: string;
  secretHash: string;
  createdBy: string;
  createdAt: string;
  enabled: boolean;
}

const RegistrationSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    space: { type: "string" },
    causePrefix: { type: "string" },
    installId: { type: "string" },
    secretHash: { type: "string" },
    createdBy: { type: "string" },
    createdAt: { type: "string" },
    enabled: { type: "boolean" },
  },
  required: [
    "id",
    "name",
    "space",
    "causePrefix",
    "installId",
    "secretHash",
    "createdBy",
    "createdAt",
    "enabled",
  ],
} as const satisfies JSONSchema;

// Records are stored verbatim (byte-identical to the wire) so the read side is
// the single schema authority. Crucially there is NO `default`: a never-written
// partition cell must read back as `undefined` (ABSENT — "never captured"),
// distinct from `[]` (EMPTY — "no signal"), which the loom read side depends on.
export const JournalSchema = {
  type: "array",
  items: { type: "object", additionalProperties: true },
} as const satisfies JSONSchema;

function randomBase62(length: number): string {
  // Rejection sampling to avoid modulo bias (256 % 62 != 0); discard >= 248.
  const LIMIT = 248;
  let result = "";
  while (result.length < length) {
    const bytes = crypto.getRandomValues(
      new Uint8Array((length - result.length) * 2),
    );
    for (const byte of bytes) {
      if (byte < LIMIT) {
        result += BASE62[byte % 62];
        if (result.length === length) break;
      }
    }
  }
  return result;
}

export function generateIngestId(): string {
  return `ing_${randomBase62(INGEST_ID_LENGTH)}`;
}

export function generateIngestSecret(): {
  secret: string;
  hashPromise: Promise<string>;
} {
  const secret = `ingsec_${randomBase62(INGEST_SECRET_BYTES)}`;
  return { secret, hashPromise: sha256(secret) };
}

export async function verifyIngestSecret(
  provided: string,
  storedHash: string,
): Promise<boolean> {
  const providedHash = await sha256(provided);
  const a = new TextEncoder().encode(providedHash);
  const b = new TextEncoder().encode(storedHash);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

// Registrations live in the toolshed's OWN service space (keyed by the operator
// identity's DID), NOT in the user's space — only the per-day records land in
// the user's space.
const registrationCell = (runtime: Runtime, serviceSpace: string, id: string) =>
  runtime.getCell<IngestRegistration>(
    serviceSpace as MemorySpace,
    `cf:ingest:${id}`,
    RegistrationSchema,
  );

export async function getRegistration(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
): Promise<IngestRegistration | null> {
  const cell = registrationCell(runtime, serviceSpace, id);
  await cell.sync();
  await runtime.storageManager.synced();
  return (cell.get() as IngestRegistration | undefined) ?? null;
}

export async function saveRegistration(
  runtime: Runtime,
  serviceSpace: string,
  registration: IngestRegistration,
): Promise<void> {
  const cell = registrationCell(runtime, serviceSpace, registration.id);
  await cell.sync();
  await runtime.storageManager.synced();
  // Operator write, not ingest — no ExternalIngest mark.
  await durableSet(cell, registration);
}

/** The partition cell for a channel — `${causePrefix}/${partition}` in the user's space. */
export function journalCell(
  runtime: Runtime,
  registration: IngestRegistration,
  partition: string,
) {
  return runtime.getCell<Record<string, unknown>[]>(
    registration.space as MemorySpace,
    `${registration.causePrefix}/${partition}`,
    JournalSchema,
  );
}

/**
 * Durably append a batch of opaque records to the channel's partition cell,
 * minting one ExternalIngest mark per POST. The read-append runs inside
 * `custodyIngest.update`'s retry, so concurrent POSTs to the same partition
 * don't lose each other. No dedup here — idempotency on the record key is the
 * read side's (loom's) job. Returns the number of records appended.
 */
export async function appendToJournal(
  runtime: Runtime,
  registration: IngestRegistration,
  partition: string,
  records: Record<string, unknown>[],
): Promise<number> {
  const cell = journalCell(runtime, registration, partition);
  await cell.sync();
  await runtime.storageManager.synced();
  const channel: VouchedChannel = {
    channel: registration.space,
    audience: registration.installId,
  };
  await custodyIngest.update(
    cell,
    (current) => [...(current ?? []), ...records],
    channel,
  );
  return records.length;
}

const DUMMY_HASH = "0".repeat(64);

/** A minimal logger shape so processIngest is testable without a pino instance. */
interface IngestLogger {
  error: (obj: unknown, msg: string) => void;
  info: (obj: unknown, msg: string) => void;
}

export type IngestResult =
  | { status: 200; body: { received: number; appended: number } }
  | { status: 400 | 401 | 413 | 502; body: { error: string } };

/**
 * The transport-independent core of the ingest handler — everything after the
 * bearer token and JSON body have been pulled off the request. Split out from
 * the Hono handler so the full auth contract (bearer lookup, dummy-hash-
 * equalized 401 for missing/disabled/wrong-token, 502-vs-401, hostile-partition
 * 400, batch cap) is unit-testable against a real runtime. `body` is the
 * already-parsed JSON payload.
 */
export async function processIngest(
  runtime: Runtime,
  serviceSpace: string,
  id: string,
  token: string,
  body: unknown,
  logger?: IngestLogger,
): Promise<IngestResult> {
  // Storage errors must 502, not masquerade as 401.
  let registration: IngestRegistration | null;
  try {
    registration = await getRegistration(runtime, serviceSpace, id);
  } catch (error) {
    logger?.error(
      { error, id },
      "ingest: storage error looking up registration",
    );
    return { status: 502, body: { error: "Failed to process request" } };
  }

  if (!registration || !registration.enabled) {
    // Match the real verification path so missing/disabled channels can't be
    // distinguished from a wrong token by timing.
    await verifyIngestSecret(token, DUMMY_HASH);
    return { status: 401, body: { error: "Invalid request" } };
  }
  if (!(await verifyIngestSecret(token, registration.secretHash))) {
    return { status: 401, body: { error: "Invalid request" } };
  }

  const partition = (body as { partition?: unknown } | null)?.partition;
  const records = (body as { records?: unknown } | null)?.records;

  if (typeof partition !== "string" || !isValidPartition(partition)) {
    return { status: 400, body: { error: "Invalid or missing partition" } };
  }
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    !records.every(
      (r) => r !== null && typeof r === "object" && !Array.isArray(r),
    )
  ) {
    return {
      status: 400,
      body: { error: "records must be a non-empty array of objects" },
    };
  }
  if (records.length > MAX_BATCH) {
    return {
      status: 413,
      body: { error: `Batch too large (max ${MAX_BATCH} records)` },
    };
  }

  try {
    const appended = await appendToJournal(
      runtime,
      registration,
      partition,
      records as Record<string, unknown>[],
    );
    logger?.info({ id, partition, appended }, "ingest: appended records");
    // received === appended in v1 (no server dedup); `appended` is a distinct
    // field only to leave room for a future dedup story without a wire change.
    return { status: 200, body: { received: records.length, appended } };
  } catch (error) {
    logger?.error({ error, id, partition }, "ingest: failed to append records");
    return { status: 502, body: { error: "Failed to write records" } };
  }
}
