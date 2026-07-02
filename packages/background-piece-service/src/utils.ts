import {
  type Cell,
  type MemorySpace,
  type Runtime,
} from "@commonfabric/runner";
import { Identity, type IdentityCreateConfig } from "@commonfabric/identity";
import { ID, type JSONSchema } from "@commonfabric/runner";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  type BGPieceEntry,
  BGPieceEntrySchema,
} from "./schema.ts";

export function isValidDID(did: string): boolean {
  return did?.startsWith("did:key:") && did.length > 10;
}

export function isValidPieceId(id: string): boolean {
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
    } catch (_e) {
      throw new Error(`Could not read key at ${identityPath}.`);
    }
  } else if (operatorPass) {
    console.warn("Using insecure passphrase identity.");
    return await Identity.fromPassphrase(operatorPass, keyConfig);
  }
  throw new Error("No IDENTITY or OPERATOR_PASS environemnt set.");
}

export async function setBGPiece({
  space,
  pieceId,
  integration,
  runtime,
  bgSpace,
  bgCause,
}: {
  space: string;
  pieceId: string;
  integration: string;
  runtime: Runtime;
  bgSpace?: MemorySpace;
  bgCause?: string;
}): Promise<boolean> {
  console.log("[setBGPiece] called with", { space, pieceId, integration });

  const piecesCell = await getBGPieces({ bgSpace, bgCause, runtime });

  console.log(
    "piecesCell",
    JSON.stringify(piecesCell.getAsLink(), null, 2),
  );

  const pieces = piecesCell.get() || [];

  const existingPieceIndex = pieces.findIndex(
    (piece: Cell<BGPieceEntry>) =>
      piece.get().space === space && piece.get().pieceId === pieceId,
  );

  if (existingPieceIndex === -1) {
    console.log("[setBGPiece] Adding piece to BGUpdater pieces cell");
    runtime.editWithRetry((tx) => {
      piecesCell.withTx(tx).push({
        [ID]: `${space}/${pieceId}`,
        space,
        pieceId,
        integration,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        disabledAt: undefined,
        lastRun: 0,
        status: "Initializing",
      });
    });

    await runtime.storageManager.synced();
    return true;
  } else {
    console.log("[setBGPiece] Piece already exists, re-enabling");
    const existingPiece = pieces[existingPieceIndex];
    runtime.editWithRetry((tx) => {
      existingPiece.withTx(tx).update({
        disabledAt: 0,
        updatedAt: Date.now(),
        status: "Re-initializing",
      });
    });
    await runtime.storageManager.synced();
    return false;
  }
}

export async function getBGPieces(
  { bgSpace, bgCause, runtime }: {
    bgSpace?: MemorySpace;
    bgCause?: string;
    runtime: Runtime;
  },
): Promise<
  Cell<Cell<BGPieceEntry>[]>
> {
  bgSpace = bgSpace ?? BG_SYSTEM_SPACE_ID;
  bgCause = bgCause ?? BG_CELL_CAUSE;

  const schema = {
    type: "array",
    items: {
      ...BGPieceEntrySchema,
      asCell: ["cell"],
    },
    default: [],
  } as const satisfies JSONSchema;

  const piecesCell = runtime.getCell(bgSpace, bgCause, schema);

  // Ensure the cell is synced
  // FIXME(ja): does True do the right thing here? Does this mean: I REALLY REALLY
  // INSIST THAT YOU HAVE THIS CELL ON THE SERVER!
  const privilegedSchema = {
    ...schema,
    ifc: { confidentiality: ["secret"] },
  } as const satisfies JSONSchema;
  await piecesCell.asSchema(privilegedSchema).sync();
  await runtime.storageManager.synced();

  return piecesCell;
}
