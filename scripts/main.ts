#!/usr/bin/env -S deno run --allow-read --allow-net --allow-env
// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { compileRecipe, PieceManager } from "@commontools/piece";
import {
  getEntityId,
  isStream,
  type MemorySpace,
  Runtime,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import {
  createSessionFromDid,
  type DID,
  Identity,
  type Session,
} from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";

const {
  spaceName,
  spaceDID,
  pieceId,
  recipeFile,
  cause,
  input,
  userKey,
  adminKey,
  quit,
} = parseArgs(Deno.args, {
  string: [
    "spaceName",
    "spaceDID",
    "pieceId",
    "recipeFile",
    "cause",
    "input",
    "userKey",
    "adminKey",
  ],
  boolean: ["quit"],
  default: { quit: false },
});

const toolshedUrl = Deno.env.get("API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const OPERATOR_PASS = Deno.env.get("OPERATOR_PASS") ?? "common user";

async function main() {
  if (!spaceName && !spaceDID) {
    console.error("No space name or space DID provided");
    Deno.exit(1);
  }

  if (spaceName?.startsWith("~") && !spaceDID) {
    console.error(
      "If space name starts with ~, then space DID must be provided",
    );
    Deno.exit(1);
  }

  if (spaceDID && !spaceDID.startsWith("did:key:")) {
    console.error("Space DID must start with did:key:");
    Deno.exit(1);
  }

  let identity: Identity;
  if (adminKey || userKey) {
    try {
      const pkcs8Key = await Deno.readFile(adminKey ?? userKey!);
      identity = await Identity.fromPkcs8(pkcs8Key);
    } catch (_) {
      console.error(`Could not read key at ${adminKey ?? userKey}.`);
      Deno.exit(1);
    }
  } else {
    identity = await Identity.fromPassphrase(OPERATOR_PASS);
  }

  // Actual identity is derived from space name if no admin key is provided.
  if (!adminKey && spaceName !== undefined) {
    identity = await identity.derive(spaceName);
  }

  const space: DID = spaceDID as DID ?? identity.did();

  const session = await createSessionFromDid({
    identity,
    space,
    spaceName: spaceName ?? "unknown",
  }) satisfies Session;

  // TODO(seefeld): It only wants the space, so maybe we simplify the above and just space the space did?
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", toolshedUrl),
    }),
    blobbyServerUrl: toolshedUrl,
  });
  const pieceManager = new PieceManager(session, runtime);
  await pieceManager.ready;
  const pieces = pieceManager.getPieces();
  pieces.sink((pieces) => {
    console.log(
      "all pieces:",
      pieces.map((c) => getEntityId(c)?.["/"]),
    );
  });

  if (pieceId) {
    const piece = await pieceManager.get(pieceId);
    if (quit) {
      if (!piece) {
        console.error("piece not found:", pieceId);
        Deno.exit(1);
      }
      console.log("piece:", pieceId);
      console.log("piece:", JSON.stringify(piece.asSchema().get(), null, 2));
      console.log(
        "sourceCell:",
        JSON.stringify(piece.getSourceCell()?.get(), null, 2),
      );
      Deno.exit(0);
    }
    piece?.sink((value) => {
      console.log("piece:", pieceId, value);
    });
  }

  let inputValue: unknown;
  if (input !== undefined && input !== "") {
    // Find all `@#<hex hash>[/<url escaoped path[/<more paths>[/...]]]`
    // and replace them with the corresponding JSON object.
    //
    // Example: "@#bafed0de/path/to/value" and "{ foo: @#bafed0de/a/path }"
    const regex = /(@#[a-zA-Z0-9]+(?:\/[^\/\s"',}\]]*)*)/g;
    const inputTransformed = input.replace(
      regex,
      (match, fullRef) => {
        // Extract hash and path from the full reference
        // fullRef format is @#hash/path or @#hash
        const hashMatch = fullRef.match(
          /@#([a-zA-Z0-9]+)((?:\/[^\/\s"',}\]]*)*)/,
        );
        if (!hashMatch) return match;

        const [_, hash, path] = hashMatch;

        // Create the cell JSON object
        const linkJson = JSON.stringify({
          cell: { "/": hash },
          path: path
            ? path.split("/").filter(Boolean).map(decodeURIComponent)
            : [],
        });

        return linkJson;
      },
    );
    try {
      console.log("inputTransformed:", inputTransformed);
      inputValue = JSON.parse(inputTransformed);
    } catch (error) {
      console.error("Error parsing input:", error);
      Deno.exit(1);
    }
  }

  function mapToCell(value: unknown): unknown {
    if (
      isRecord(value) && isRecord(value.cell) &&
      typeof value.cell["/"] === "string" &&
      Array.isArray(value.path)
    ) {
      const localSpace = (value.space ?? spaceDID) as MemorySpace;
      return runtime.getCellFromLink({
        space: localSpace,
        id: `of:${value.cell["/"]}`,
        path: value.path,
      });
    } else if (Array.isArray(value)) {
      return value.map(mapToCell);
    } else if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [key, mapToCell(value)]),
      );
    }
    return value;
  }

  inputValue = mapToCell(inputValue);

  if (recipeFile) {
    try {
      const recipeSrc = await Deno.readTextFile(recipeFile);
      const recipe = await compileRecipe(
        recipeSrc,
        "recipe",
        runtime,
        space,
      );
      const piece = await pieceManager.runPersistent(
        recipe,
        inputValue,
        cause,
      );
      const pieceWithSchema = (await pieceManager.get(piece))!;
      pieceWithSchema.sink((value) => {
        console.log("running piece:", getEntityId(piece), value);
      });
      const updater = pieceWithSchema.get()?.updater;
      if (isStream(updater)) {
        console.log("running updater");
        updater.send({ newValues: ["test"] });
      }
      if (quit) {
        await runtime.idle();
        await runtime.storageManager.synced();
        // This console.log is load bearing for the integration tests. This is
        // how the integration tests get the piece ID.
        console.log("created piece: ", getEntityId(piece)!["/"]);
        Deno.exit(0);
      }
    } catch (error) {
      console.error("Error loading and compiling recipe:", error);
      if (quit) {
        await runtime.storageManager.synced();
        Deno.exit(1);
      }
    }
  }

  return new Promise(() => {
    // This promise never resolves, keeping the program alive
    console.log("Program running. Press Ctrl+C to exit.");
  });
}

main();
