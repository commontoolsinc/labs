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

// The partition leaf the caller chooses (e.g. a UTC day `2026-07-01`). The
// write is ALWAYS confined to the channel's registered space + causePrefix, so
// the partition value is not a security boundary — this bound just keeps it a
// single clean segment so labs and loom derive the same cell cause.
const PARTITION_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const isValidPartition = (p: string): boolean => PARTITION_RE.test(p);

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
    (current) => [
      ...((current as Record<string, unknown>[] | undefined) ?? []),
      ...records,
    ],
    channel,
  );
  return records.length;
}
