// Provision a vouched ingest channel — the OPERATOR / break-glass path.
//
// PREFER `cf ingest mint`. Users can now mint their own channels against
// /api/ingest-channels, signing with their own identity key; the server checks
// they hold an explicit OWNER grant on the target space's ACL, which is what
// closes the confused-deputy hole that kept creation out-of-band originally.
// See docs/features/self-serve-ingest-channels.md.
//
// This script remains for the cases the self-serve path cannot cover: minting
// for a space whose ACL does not (yet) name a concrete owner, and recovery when
// the control plane itself is unavailable. It bypasses the ownership check
// entirely — it runs AS the operator identity — so treat it as an admin action.
//
// A channel minted here has no verified `owner`, so it does not appear in a
// user's own `cf ingest ls`. It DOES appear in `cf ingest ls --space <space>`,
// which lists everything targeting a space its current owner holds — so a
// break-glass channel is discoverable, and revocable, by that owner.
//
// It mints a per-install token, writes the registration into the toolshed
// service space, and prints the token ONCE. Adding an install = re-run this.
//
// Usage:
//   deno task provision-ingest-channel \
//     --space did:key:<user-space> --install-id <stable-id> \
//     [--cause-prefix location] [--name <label>] [--force]
import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  channelId,
  generateIngestSecret,
  getRegistration,
  isValidSegment,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import { DEFAULT_TTL_DAYS } from "@/routes/ingest-channels/ingest-channels.utils.ts";

const flags = parseArgs(Deno.args, {
  string: ["space", "install-id", "cause-prefix", "name"],
  boolean: ["force"],
});

const space = flags.space;
const installId = flags["install-id"];
if (!space || !installId) {
  console.error(
    "usage: deno task provision-ingest-channel --space <did:key:...> " +
      "--install-id <id> [--cause-prefix location] [--name <label>] [--force]",
  );
  Deno.exit(2);
}
// A typo'd space durably writes marked data into a garbage space (loom's reader
// silently orphaned); installId is the mark's audience AND a `\n`-separated input
// to channelId, so whitespace/newlines corrupt the cross-repo join key.
if (!space.startsWith("did:")) {
  console.error(`Invalid --space '${space}': must be a DID (did:...).`);
  Deno.exit(2);
}
if (!isValidSegment(installId)) {
  console.error(
    `Invalid --install-id '${installId}': must match [A-Za-z0-9._-]{1,64} and not be '.' or '..'`,
  );
  Deno.exit(2);
}
const causePrefix = flags["cause-prefix"] ?? "location";
const name = flags.name ?? `ingest-${installId}`;

// causePrefix is the other half of the `${causePrefix}/${partition}` cause that
// loom must recompute to read the cells — hold it to the same clean-segment rule
// as the partition so an operator typo can't silently orphan the read path.
if (!isValidSegment(causePrefix)) {
  console.error(
    `Invalid --cause-prefix '${causePrefix}': must match [A-Za-z0-9._-]{1,64} and not be '.' or '..'`,
  );
  Deno.exit(2);
}

const runtime = new Runtime({
  apiUrl: new URL(env.MEMORY_URL),
  storageManager: StorageManager.open({
    memoryHost: new URL(env.MEMORY_URL),
    as: identity,
  }),
});

try {
  // Deterministic id: re-running for the same space+install rotates the token in
  // place (overwrites the one registration) rather than leaving a stale one live.
  const id = channelId(space, installId);

  // Re-provisioning with a different --cause-prefix would rotate the token AND
  // silently move where data lands (orphaning loom's existing read path), since
  // channelId derives from (space, installId) only. Refuse unless --force.
  const existing = await getRegistration(runtime, identity.did(), id);
  if (existing && existing.causePrefix !== causePrefix && !flags.force) {
    console.error(
      `Channel ${id} already exists with cause-prefix '${existing.causePrefix}', ` +
        `not '${causePrefix}'. Re-run with --force to repoint (this orphans the ` +
        `old read path), or keep the existing prefix.`,
    );
    Deno.exit(2);
  }
  if (existing) console.log(`rotating token for existing channel ${id}`);

  const { secret, secretHash } = generateIngestSecret();

  // Carry the existing lifecycle state forward. Building a fresh object here
  // silently un-revokes a retired channel, deletes its revocation history,
  // orphans a self-serve channel from its owner's list, resets the revision
  // that lifecycle writes are gated on, and drops the expiry — which is the
  // only way this deployment can still issue a credential that never expires.
  const now = new Date();
  const expiresAt = existing?.expiresAt !== undefined &&
      Date.parse(existing.expiresAt) > now.getTime()
    ? existing.expiresAt
    : new Date(now.getTime() + DEFAULT_TTL_DAYS * 86_400_000).toISOString();

  await saveRegistration(runtime, identity.did(), {
    id,
    name,
    space,
    causePrefix,
    installId,
    sink: "journal",
    secretHash,
    createdBy: identity.did(),
    createdAt: existing?.createdAt ?? now.toISOString(),
    enabled: true,
    expiresAt,
    revision: (existing?.revision ?? 0) + 1,
    ...(existing?.owner !== undefined ? { owner: existing.owner } : {}),
    // Re-provisioning is an operator re-authorizing the channel, so the live
    // revocation clears; the record of it does not.
    ...(existing?.revoked !== undefined
      ? {
        revocations: [
          ...(existing.revocations ?? []).map((r) => ({ at: r.at, by: r.by })),
          { at: existing.revoked.at, by: existing.revoked.by },
        ],
      }
      : existing?.revocations !== undefined
      ? {
        revocations: existing.revocations.map((r) => ({ at: r.at, by: r.by })),
      }
      : {}),
  });
  await runtime.storageManager.synced();

  const url = `${env.API_URL}/api/ingest/${id}`;
  console.log("\nIngest channel provisioned.\n");
  console.log(`  id:          ${id}`);
  console.log(`  name:        ${name}`);
  console.log(`  space:       ${space}`);
  console.log(`  causePrefix: ${causePrefix}`);
  console.log(`  installId:   ${installId}`);
  console.log(`  URL:         ${url}`);
  console.log(
    `\n  token (shown once — hand to the beacon, sent as 'Authorization: Bearer <token>'):\n\n    ${secret}\n`,
  );
  console.log(
    "  (re-running with the same --space and --install-id rotates this channel's\n" +
      "   token in place; the previous token stops working.)\n",
  );
} finally {
  await runtime.dispose();
}
