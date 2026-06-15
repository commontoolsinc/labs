import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { parseFabricRef } from "../src/sandbox/fabric-import-specifier.ts";
import { resolveFabricRefToIdentity } from "../src/fabric-ref-resolution.ts";
import { createRef } from "../src/create-ref.ts";
import { fromURI, toURI } from "../src/uri-utils.ts";
import { type PatternMeta, patternMetaSchema } from "../src/pattern-manager.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import type { Cell } from "../src/cell.ts";
import type { URI } from "../src/sigil-types.ts";
import { getSigilLink } from "../src/runner-utils.ts";

const signer = await Identity.fromPassphrase("fabric ref resolution test");
const space = signer.did();

const ENTRY_A = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";
const ENTRY_B = "Bvcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("fabric ref resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function parse(specifier: string) {
    const ref = parseFabricRef(specifier);
    if (ref === undefined) throw new Error(`not a fabric ref: ${specifier}`);
    return ref;
  }

  function newPatternId(label: string): URI {
    return toURI(createRef({ pattern: label }, "fabric ref resolution"));
  }

  function hashFromPatternId(patternId: URI): string {
    return fromURI(patternId).replace(/^fid1:/, "");
  }

  function patternMetaCell(patternId: URI): Cell<PatternMeta> {
    return runtime.getCellFromEntityId(
      space,
      { "/": fromURI(patternId) },
      [],
      patternMetaSchema,
    );
  }

  async function writePatternMeta(
    patternId: URI,
    meta: Partial<PatternMeta>,
  ): Promise<Cell<PatternMeta>> {
    const cell = patternMetaCell(patternId);
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({ ...meta } as PatternMeta);
    });
    return cell;
  }

  function pieceCell(label: string): Cell<unknown> {
    return runtime.getCell(
      space,
      { space, random: `piece-${label}` },
    );
  }

  async function writeSlug(slug: string, target: Cell<unknown>): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(space, {
      "/": slugIdForSpace(space, slug),
    });
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  it("returns terminal identities for pattern refs", async () => {
    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse(`cf:pattern:${ENTRY_A}`),
    );

    expect(result).toEqual({
      entryIdentity: ENTRY_A,
      chain: [`pattern:${ENTRY_A}`, `entryIdentity:${ENTRY_A}`],
    });
  });

  it("rejects space names until name to DID resolution exists", async () => {
    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:/kitchen/todo")),
    ).rejects.toThrow(
      "space names require name→DID resolution (open question 2); use a DID",
    );
  });

  it("resolves slug to piece patternIdentity metadata", async () => {
    const patternId = newPatternId("identity-piece");
    const piece = pieceCell("identity");
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "piece" });
      pieceWithTx.setMetaRaw("pattern", getSigilLink(patternId));
      pieceWithTx.setMetaRaw("patternIdentity", {
        identity: ENTRY_A,
        symbol: "default",
      });
    });
    await writeSlug("dep", piece);

    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse("cf:dep"),
    );

    expect(result.entryIdentity).toBe(ENTRY_A);
    expect(result.chain).toEqual([
      "slug:dep",
      `piece:${piece.getAsNormalizedFullLink().id}`,
      `patternIdentity:${ENTRY_A}`,
      `entryIdentity:${ENTRY_A}`,
    ]);
  });

  it("resolves slug directly to a pattern meta cell", async () => {
    const patternId = newPatternId("direct-meta");
    const meta = await writePatternMeta(patternId, { entryIdentity: ENTRY_A });
    await writeSlug("direct-meta", meta);

    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse("cf:direct-meta"),
    );

    expect(result.entryIdentity).toBe(ENTRY_A);
    expect(result.chain).toEqual([
      "slug:direct-meta",
      `patternMeta:${patternId}`,
      `entryIdentity:${ENTRY_A}`,
    ]);
  });

  it("reports slug to plain data cells with the chain", async () => {
    const cell = runtime.getCell(space, { space, random: "plain-data" });
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({ value: 1 });
    });
    await writeSlug("plain", cell);

    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:plain")),
    ).rejects.toThrow(
      `cf:plain does not resolve to a pattern (chain: slug:plain)`,
    );
  });

  it("wraps missing slug errors with the chain", async () => {
    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:missing")),
    ).rejects.toThrow(`Slug "missing" not found. (chain: slug:missing)`);
  });

  it("resolves of: refs directly to pattern meta cells", async () => {
    const patternId = newPatternId("of-meta");
    await writePatternMeta(patternId, { entryIdentity: ENTRY_A });

    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse(`cf:of:fid1:${hashFromPatternId(patternId)}`),
    );

    expect(result.entryIdentity).toBe(ENTRY_A);
    expect(result.chain).toEqual([
      `of:${patternId}`,
      `patternMeta:${patternId}`,
      `entryIdentity:${ENTRY_A}`,
    ]);
  });

  it("resolves pieces with legacy patternId metadata through pattern meta", async () => {
    const patternId = newPatternId("legacy-pattern-id");
    await writePatternMeta(patternId, { entryIdentity: ENTRY_B });
    const piece = pieceCell("legacy");
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "legacy" });
      pieceWithTx.setMetaRaw("pattern", getSigilLink(patternId));
    });
    await writeSlug("legacy", piece);

    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse("cf:legacy"),
    );

    expect(result.entryIdentity).toBe(ENTRY_B);
    expect(result.chain).toEqual([
      "slug:legacy",
      `piece:${piece.getAsNormalizedFullLink().id}`,
      `patternMeta:${patternId}`,
      `entryIdentity:${ENTRY_B}`,
    ]);
  });

  it("reports legacy pattern meta without entryIdentity", async () => {
    const patternId = newPatternId("missing-entry-identity");
    // A legacy meta cell carries a stored program but predates entryIdentity;
    // the program is what marks the cell as pattern meta (the `spec` marker
    // was retired in the pattern-id retirement W1).
    await writePatternMeta(patternId, {
      program: {
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      },
    } as Partial<PatternMeta>);

    await expect(
      resolveFabricRefToIdentity(
        runtime,
        space,
        parse(`cf:of:fid1:${hashFromPatternId(patternId)}`),
      ),
    ).rejects.toThrow(
      `pattern meta for cf:of:fid1:${
        hashFromPatternId(patternId)
      } has no entryIdentity (legacy pattern; re-deploy it)`,
    );
  });
});
