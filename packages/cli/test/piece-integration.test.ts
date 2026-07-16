// Integration tests for `cf piece get` against a live toolshed. The suite
// runs when API_URL names a running toolshed (as in the CI cli-integration
// jobs) and is skipped otherwise. A throwaway identity keyfile and space are
// created per run. Run locally with:
//   API_URL=http://localhost:8000 deno test --allow-net --allow-ffi \
//     --allow-read --allow-write --allow-env --allow-run \
//     test/piece-integration.test.ts
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import type { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { writeTempIdentity } from "@commonfabric/integration/temp-identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  callPieceHandler,
  type EntryConfig,
  newPiece,
  type SpaceConfig,
} from "../lib/piece.ts";
import { integrationCf } from "./utils.ts";

const API_URL = Deno.env.get("API_URL");

const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const NOTE_PATTERN = `${REPO_ROOT}/packages/patterns/notes/note.tsx`;

const NOTE_CONTENT = "Hello world";

const noteEntry: EntryConfig = {
  mainPath: NOTE_PATTERN,
  rootPath: `${REPO_ROOT}/packages/patterns`,
};

let pieceId = "";
let flags = "";
let identityPath = "";

// Resolves once the piece's result/content cell holds `expected`. Uses its
// own controller, so readiness is judged from a fresh client's view of the
// server.
async function waitForContent(
  identity: Identity,
  spaceName: string,
  piece: string,
  expected: string,
): Promise<void> {
  const pieces = await PiecesController.initialize({
    apiUrl: new URL(API_URL!),
    identity,
    spaceName,
  });
  try {
    const controller = await pieces.get(piece);
    const contentCell = (await controller.result.getCell())
      .asSchema<{ content?: string }>()
      .key("content");
    await contentCell.pull();
    await waitForCellValue<string>(
      pieces.manager().runtime,
      contentCell,
      (value) => value === expected,
    );
  } finally {
    await pieces.dispose();
  }
}

describe("cf piece get (integration)", { ignore: !API_URL }, () => {
  beforeAll(async () => {
    const { identity, path } = await writeTempIdentity();
    identityPath = path;
    const spaceName = `cf-piece-get-test-${Date.now()}`;
    const spaceConfig: SpaceConfig = {
      apiUrl: API_URL!,
      space: spaceName,
      identity: identityPath,
    };
    pieceId = await newPiece(spaceConfig, noteEntry);
    await callPieceHandler(
      { ...spaceConfig, piece: pieceId },
      "setTitle",
      "Integration Test Note",
    );
    await callPieceHandler(
      { ...spaceConfig, piece: pieceId },
      "editContent",
      { detail: { value: NOTE_CONTENT } },
    );
    flags =
      `--api-url ${API_URL} --identity ${identityPath} --space ${spaceName} --piece ${pieceId}`;
    await waitForContent(identity, spaceName, pieceId, NOTE_CONTENT);
  });

  afterAll(async () => {
    // Ephemeral space names ensure isolation; only the throwaway identity
    // keyfile needs removing.
    if (identityPath) {
      await Deno.remove(identityPath);
    }
  });

  it("bad path exits 1 with Available keys: in output", async () => {
    const { code, stderr } = await integrationCf(
      `piece get ${flags} nonexistent`,
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("Available keys:");
  });

  it("good path exits 0 with valid output", async () => {
    const { code, stdout } = await integrationCf(`piece get ${flags} content`);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("no path returns full result JSON", async () => {
    const { code, stdout } = await integrationCf(`piece get ${flags}`);
    expect(code).toBe(0);
    const json = JSON.parse(stdout.join(""));
    expect(typeof json).toBe("object");
  });
});
