import { Charm } from "@commontools/charm";
import {
  type Cell,
  getEntityId,
  type MemorySpace,
  type Runtime,
} from "@commontools/runner";
import { Identity, type IdentityCreateConfig } from "@commontools/identity";
import { ID, type JSONSchema } from "@commontools/runner";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  type BGCharmEntry,
  BGCharmEntrySchema,
} from "./schema.ts";

/**
 * Custom logger that includes timestamp and optionally charm ID
 * @param message - The message to log
 * @param options - Optional parameters
 * @param options.charm - Charm cell or ID to include in the log
 * @param options.error - Whether to log as error instead of info
 * @param args - Additional arguments to log
 */
export function log(
  message: any,
  options?: { charm?: Cell<Charm> | string; error?: boolean },
  ...args: any[]
) {
  let charmIdSuffix = "";

  if (options?.charm) {
    const charm = options.charm;
    if (typeof charm === "string") {
      charmIdSuffix = `[${charm.slice(-10)}]`;
    } else {
      const id = getEntityId(charm)?.["/"];
      if (id) {
        charmIdSuffix = `[${id.slice(-10)}]`;
      }
    }
  }

  if (options?.error) {
    if (charmIdSuffix) {
      console.error(charmIdSuffix, message, ...args);
    } else {
      console.error(message, ...args);
    }
  } else {
    if (charmIdSuffix) {
      console.log(charmIdSuffix, message, ...args);
    } else {
      console.log(message, ...args);
    }
  }
}

export function isValidDID(did: string): boolean {
  return did?.startsWith("did:key:") && did.length > 10;
}

export function isValidCharmId(id: string): boolean {
  return !!id && id.length === 59;
}

// Derives the identity configured for this service,
// receiving an `IDENTITY` and `OPERATOR_PASS` from the environment.
//
// First, uses the key path to load a key.
// If not set, falls back to operator pass to
// use an insecure passphrase.
// This fallback should be removed once fully migrated
// over to using keyfiles.
export async function getIdentity(
  identityPath?: string,
  operatorPass?: string,
): Promise<Identity> {
  // Deno does not support serializing `CryptoKey`, safely
  // passing keys to workers. Explicitly use the fallback implementation,
  // which makes key material available to the JS context, in order
  // to transfer key material to workers.
  // https://github.com/denoland/deno/issues/12067#issuecomment-1975001079
  const keyConfig: IdentityCreateConfig = {
    implementation: "noble",
  };

  if (identityPath) {
    console.log(`Using identity at ${identityPath}`);
    try {
      const pkcs8Key = await Deno.readFile(identityPath);
      return await Identity.fromPkcs8(pkcs8Key, keyConfig);
    } catch (e) {
      throw new Error(`Could not read key at ${identityPath}.`);
    }
  } else if (operatorPass) {
    console.warn("Using insecure passphrase identity.");
    return await Identity.fromPassphrase(operatorPass, keyConfig);
  }
  throw new Error("No IDENTITY or OPERATOR_PASS environemnt set.");
}

export async function setBGCharm({
  space,
  charmId,
  integration,
  runtime,
  bgSpace,
  bgCause,
}: {
  space: string;
  charmId: string;
  integration: string;
  runtime: Runtime;
  bgSpace?: MemorySpace;
  bgCause?: string;
}): Promise<boolean> {
  const charmsCell = await getBGCharms({
    bgSpace,
    bgCause,
    runtime,
  });

  console.log(
    "charmsCell",
    JSON.stringify(charmsCell.getAsLink(), null, 2),
  );

  const charms = charmsCell.get() || [];

  const existingCharmIndex = charms.findIndex(
    (charm: Cell<BGCharmEntry>) =>
      charm.get().space === space && charm.get().charmId === charmId,
  );

  if (existingCharmIndex === -1) {
    console.log("Adding charm to BGUpdater charms cell");
    const tx = runtime.edit();
    charmsCell.withTx(tx).push({
      [ID]: `${space}/${charmId}`,
      space,
      charmId,
      integration,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      disabledAt: undefined,
      lastRun: 0,
      status: "Initializing",
    } as unknown as Cell<BGCharmEntry>);
    await tx.commit();

    // Ensure changes are synced
    await runtime.storage.synced();

    return true;
  } else {
    console.log("Charm already exists in BGUpdater charms cell, re-enabling");
    const existingCharm = charms[existingCharmIndex];
    const tx = runtime.edit();
    existingCharm.withTx(tx).update({
      disabledAt: 0,
      updatedAt: Date.now(),
      status: "Re-initializing",
    });
    tx.commit(); // TODO(seefeld): We don't retry writing this. Should we?
    await runtime.storage.synced();

    return false;
  }
}

export async function getBGCharms(
  { bgSpace, bgCause, runtime }: {
    bgSpace?: MemorySpace;
    bgCause?: string;
    runtime: Runtime;
  },
): Promise<
  Cell<Cell<BGCharmEntry>[]>
> {
  bgSpace = bgSpace ?? BG_SYSTEM_SPACE_ID;
  bgCause = bgCause ?? BG_CELL_CAUSE;

  const schema = {
    type: "array",
    items: {
      ...BGCharmEntrySchema,
      asCell: true,
    },
    default: [],
  } as const satisfies JSONSchema;

  const charmsCell = runtime.getCell(bgSpace, bgCause, schema);

  // Ensure the cell is synced
  // FIXME(ja): does True do the right thing here? Does this mean: I REALLY REALLY
  // INSIST THAT YOU HAVE THIS CELL ON THE SERVER!
  const privilegedSchema = {
    ...schema,
    ifc: { classification: ["secret"] },
  } as const satisfies JSONSchema;
  await charmsCell.asSchema(privilegedSchema).sync();
  await runtime.storage.synced();

  return charmsCell;
}
