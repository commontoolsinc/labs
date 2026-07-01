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
  generateIngestId,
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
  const id = generateIngestId();
  const { secret, hashPromise } = generateIngestSecret();
  const secretHash = await hashPromise;

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
} finally {
  await runtime.dispose();
}
