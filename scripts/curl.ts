// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { type DID, Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { URI } from "@commontools/memory/interface";
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
  boolean: ["admin", "delete", "raw"],
  default: { the: "application/json", admin: false, raw: false, delete: false },
});

const toolshedUrl = Deno.env.get("API_URL") ??
  "http://localhost:8000/";

const ANYONE = "common user";
const remoteStorageUrl = new URL(toolshedUrl);

function usage() {
  console.log(
    "Usage: curl [--key <keyfile>] [--spaceName <spaceName>] [--admin] [--raw] [--schema <schema>] [--data <data>] url\n" +
      "Example URL: ct://did:key:z6MkjMowGqCog2ZfvNBNrx32p2Fa2bKR1nT7pUWiPQFWzVAg/baedreihxpwcmhvzpf5weuf4ceow4zbahqikvu5ploox36ipeuvqnminyba/application/json\n" +
      "If you provide a spaceDID in the URL, you must either be using the admin flag, or provide the --spaceName option.\n" +
      "You can also provide a spaceName in the URL if it does not include any colon or slash characters. In this case, you do not need to provide the --spaceName option.",
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
  // We don't allow fetching the application/commit+json of the space, since
  // the space is not an entity (not available with the 'of:` prefix).
  // did key is base58btc; entity id is base32; attribute is mime type-ish
  const urlRegex: RegExp =
    /^(ct:\/\/)?((?<spaceDID>(did:key:[1-9A-HJ-NP-Za-km-z]{48}))|(?<spaceName>[^/:]+))\/(?<of>[a-z2-7]{59})(\/(?<the>\w+\/[-+.\w]+))?$/;
  const match = url.match(urlRegex);
  if (match === null || match.groups === undefined) {
    console.error("Invalid url");
    Deno.exit(1);
  }
  const entityId = { "/": match.groups.of };
  const uri: URI = `of:${match.groups.of}`;
  const the = (match.groups.the && match.groups.the !== "")
    ? match.groups.the
    : "application/json";
  if (!match.groups.spaceName && !match.groups.spaceDID) {
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
  if (!flags.admin) {
    const spaceName = match.groups.spaceName ?? flags.spaceName;
    identity = await identity.derive(spaceName);
  }
  const spaceDID = match.groups.spaceDID
    ? match.groups.spaceDID as DID
    : identity.did();
  const schema = flags.schema ? JSON.parse(flags.schema) : {};

  // TODO(@ubik2) - this constrains us to values that are json
  // need to revisit for image or blob support
  const putData = flags.data ? JSON.parse(flags.data) : undefined;

  const storageId = crypto.randomUUID();
  const provider = StorageManager.open({
    id: storageId,
    address: new URL("/api/storage/memory", remoteStorageUrl),
    as: identity,
    settings: {
      maxSubscriptionsPerSpace: 50_000,
      connectionTimeout: 30_000,
    },
  }).open(spaceDID);
  // Before writing data, we need to read it to check if it's changed.
  // Since we need to read in either case, just do that here
  const syncResult = await provider.sync(uri, {
    path: [],
    schemaContext: {
      schema: schema,
      rootSchema: schema,
    },
  });
  if (syncResult.error) {
    console.log("Failed to sync object", syncResult.error);
  }
  if (!putData && !flags.delete) {
    const storageValue = provider.get(uri);
    const data = flags.raw ? storageValue : storageValue?.value;

    console.log(JSON.stringify(data));
    Deno.exit(0);
  } else {
    // The entries in the database all get a value key and store their value there,
    // so we need to do the same for the value we provide to StorageValue for send.
    const result = await provider.send([{
      uri: uri,
      value: flags.delete
        ? { value: undefined }
        : flags.raw
        ? putData
        : { value: putData },
    }]);
    if (result.ok) {
      if (flags.delete) {
        console.log(
          `Deleted (retracted) at ct://${spaceDID}/${entityId["/"]}/${the}`,
        );
      }
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
