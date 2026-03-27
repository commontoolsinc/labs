import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import {
  callPieceHandler,
  type EntryConfig,
  newPiece,
  type SpaceConfig,
} from "../lib/piece.ts";
import { ct } from "./utils.ts";

const INTEGRATION = Deno.env.get("CT_INTEGRATION") === "1";

const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const NOTE_PATTERN = `${REPO_ROOT}/packages/patterns/notes/note.tsx`;

const spaceConfig: SpaceConfig = {
  apiUrl: "http://localhost:8000",
  space: `ct-1406-test-${Date.now()}`,
  identity: "/tmp/bench.key",
};

const noteEntry: EntryConfig = {
  mainPath: NOTE_PATTERN,
  rootPath: `${REPO_ROOT}/packages/patterns`,
};

let pieceId = "";
let flags = "";

async function waitForContent(waitFlags: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const { code } = await ct(`piece get ${waitFlags} result/content`);
    if (code === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Piece never became ready");
}

describe("ct piece get (integration)", { ignore: !INTEGRATION }, () => {
  beforeAll(async () => {
    pieceId = await newPiece(spaceConfig, noteEntry);
    await callPieceHandler(
      { ...spaceConfig, piece: pieceId },
      "setTitle",
      "Integration Test Note",
    );
    await callPieceHandler(
      { ...spaceConfig, piece: pieceId },
      "editContent",
      { detail: { value: "Hello world" } },
    );
    flags =
      `--api-url http://localhost:8000 --identity /tmp/bench.key --space ${spaceConfig.space} --piece ${pieceId}`;
    await waitForContent(flags);
  });

  afterAll(async () => {
    // No cleanup required — ephemeral space names ensure isolation.
    await Promise.resolve();
  });

  it("bad path exits 1 with Available keys: in output", async () => {
    const { code, stdout } = await ct(
      `piece get ${flags} result/nonexistent`,
    );
    expect(code).toBe(1);
    expect(stdout.join("\n")).toContain("Available keys:");
  });

  it("good path exits 0 with valid output", async () => {
    const { code, stdout } = await ct(`piece get ${flags} result/content`);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("no path returns full result JSON", async () => {
    const { code, stdout } = await ct(`piece get ${flags}`);
    expect(code).toBe(0);
    const json = JSON.parse(stdout.join(""));
    expect(typeof json).toBe("object");
  });
});
