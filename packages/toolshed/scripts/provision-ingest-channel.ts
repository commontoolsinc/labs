// Provision a vouched ingest channel (iteration 1: out-of-band, operator-run).
//
// Why: iteration 1 has no self-serve create endpoint on purpose — an unauthed
// create that takes a caller-supplied target space is a confused-deputy write
// primitive (anyone could get a legitimately-minted mark written into another
// user's space). Until the platform has HTTP-level caller auth, channels are
// minted here, by an operator who already holds the service identity. This mints
// a per-install token, writes the registration into the toolshed service space,
// and prints the token ONCE. Adding an install = re-run this; no redeploy.
//
// Usage:
//   deno task provision-ingest-channel \
//     --space did:key:<user-space> --install-id <stable-id> \
//     [--cause-prefix location] [--name <label>]
import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  channelId,
  generateIngestSecret,
  isValidSegment,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";

const flags = parseArgs(Deno.args, {
  string: ["space", "install-id", "cause-prefix", "name"],
});

const space = flags.space;
const installId = flags["install-id"];
if (!space || !installId) {
  console.error(
    "usage: deno task provision-ingest-channel --space <did:key:...> " +
      "--install-id <id> [--cause-prefix location] [--name <label>]",
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
  const { secret, secretHash } = generateIngestSecret();

  await saveRegistration(runtime, identity.did(), {
    id,
    name,
    space,
    causePrefix,
    installId,
    secretHash,
    createdBy: identity.did(),
    createdAt: new Date().toISOString(),
    enabled: true,
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
