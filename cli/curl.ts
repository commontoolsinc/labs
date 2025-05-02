// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { type DID, Identity } from "@commontools/identity";
import { Provider as CachedStorageProvider } from "../runner/src/storage/cache.ts";
//
// Some examples of how you can use this to play with the classification labels
// Store the empty list
// > deno task curl --spaceName robin --data '[]' ct://did:key:z6MkjMowGqCog2ZfvNBNrx32p2Fa2bKR1nT7pUWiPQFWzVAg/baedreih5ute2slgsylwtbszccarx6ky2ca3mtticxug6sfj3nwamacefmn/application/json
// Mark the entity secret
// > deno task curl --spaceName robin --raw --data '{"classification": ["secret"]}' ct://did:key:z6MkjMowGqCog2ZfvNBNrx32p2Fa2bKR1nT7pUWiPQFWzVAg/baedreih5ute2slgsylwtbszccarx6ky2ca3mtticxug6sfj3nwamacefmn/application/label+json
// Check the classification labels (requires the classification labels)
// > deno task curl --spaceName robin --raw --schema '{"ifc": {"classification": ["secret"]}}' ct://did:key:z6MkjMowGqCog2ZfvNBNrx32p2Fa2bKR1nT7pUWiPQFWzVAg/baedreih5ute2slgsylwtbszccarx6ky2ca3mtticxug6sfj3nwamacefmn/application/label+json
// Get the original empty list back (requires the classification labels)
// > deno task curl --spaceName robin --schema '{"ifc": {"classification": ["secret"]}}' ct://did:key:z6MkjMowGqCog2ZfvNBNrx32p2Fa2bKR1nT7pUWiPQFWzVAg/baedreih5ute2slgsylwtbszccarx6ky2ca3mtticxug6sfj3nwamacefmn/application/json
const flags = parseArgs(Deno.args, {
  string: [
    "spaceName",
    "key",
    "data",
    "schema",
  ],
  boolean: ["admin"],
  default: { the: "application/json", admin: false, raw: false },
});

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "http://localhost:8000/";

const ANYONE = "common user";
const remoteStorageUrl = new URL(toolshedUrl);

function usage() {
  console.log(
    "Usage: curl [--key <keyfile>] [--spaceName <spaceName>] [--admin] [--raw] [--schema <schema>] [--data <data>] url\n" +
      "Example url: ct://did:key:z6MkjMowGqCog2ZfvNBNrx32p2Fa2bKR1nT7pUWiPQFWzVAg/baedreihxpwcmhvzpf5weuf4ceow4zbahqikvu5ploox36ipeuvqnminyba/application/json",
  );
}
async function main() {
  const url = flags._[0];
  if (!url || typeof url !== "string") {
    console.error("Must provide an url");
    usage();
    Deno.exit(1);
  }
  // Parse the url like ct://spaceDID/entityID/attribute
  // did key is base58btc; entity id is base32; attribute is mime type-ish
  const urlRegex: RegExp =
    /^(ct:\/\/)?(?<at>(did:key:[1-9A-HJ-NP-Za-km-z]+))\/(?<of>[a-z2-7]+)(\/(?<the>\w+\/[-+.\w]+))?$/;
  const match = url.match(urlRegex);
  if (match === null || match.groups === undefined) {
    console.error("Invalid url");
    Deno.exit(1);
  }
  const spaceDID = match.groups.at as DID;
  const entityId = { "/": match.groups.of };
  const the = (match.groups.the && match.groups.the !== "")
    ? match.groups.the
    : "application/json";
  if (!flags.spaceName && !spaceDID) {
    console.error("No space name or space DID found");
    Deno.exit(1);
  }

  let identity: Identity;
  if (flags.key) {
    try {
      const pkcs8Key = await Deno.readFile(flags.key);
      identity = await Identity.fromPkcs8(pkcs8Key);
    } catch (e) {
      console.error(
        `Could not read key at ${flags.key}.`,
      );
      Deno.exit(1);
    }
  } else {
    identity = await Identity.fromPassphrase(ANYONE);
  }

  // Actual identity is derived from space name if we don't provide an admin key
  if (!flags.admin && flags.spaceName !== undefined) {
    identity = await identity.derive(flags.spaceName);
  }

  const schema = flags.schema ? JSON.parse(flags.schema) : {};

  // TODO(@ubik2) - this constrains us to values that are json
  // need to revisit for image or blob support
  const putData = flags.data ? JSON.parse(flags.data) : undefined;

  const storageId = crypto.randomUUID();
  const provider = new CachedStorageProvider({
    id: storageId,
    address: new URL("/api/storage/memory", remoteStorageUrl),
    space: spaceDID,
    as: identity,
    the: the,
    settings: {
      maxSubscriptionsPerSpace: 50_000,
      connectionTimeout: 30_000,
      useSchemaQueries: true,
    },
  });
  if (!putData) {
    const result = await provider.sync(entityId, true, {
      schema: schema,
      rootSchema: schema,
    });
    if (result.error) {
      console.log("Failed to sync object", result.error);
    }
    const storageValue = provider.get(entityId);
    const data = flags.raw ? storageValue : storageValue?.value;

    console.log(JSON.stringify(data));
    Deno.exit(0);
  } else {
    // The entries in the database all get a value key and store their value there,
    // so we need to do the same for the value we provide to StorageValue for send.
    const result = await provider.send([{
      entityId: entityId,
      value: flags.raw ? putData : { value: putData },
    }]);
    if (result.ok) {
      const putDataJSON = JSON.stringify(putData);
      console.log(
        `Stored ${putDataJSON} at ct://${spaceDID}/${entityId["/"]}/${the}`,
      );
    } else {
      console.error("Failed to put data:", result.error);
    }
    Deno.exit(0);
  }
}
main();
