/**
 * Creation-time space labeling: every piece the controller creates records a
 * declared confidentiality on the piece document — `PersonalSpace(<space>)`
 * when the space is its owner's identity space, `Space(<space did>)`
 * otherwise — and a piece whose document already carries confidentiality
 * keeps its own labeling.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import {
  type Cell,
  resolveEntryIdentity,
  resolveSystemPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  DEFAULT_APP_PATTERN_SOURCE,
  PiecesController,
} from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece creation labels");

const COUNTER_SOURCE = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern<{ label: string }>(({ label }) => {",
  "  const count = new Writable(0).for('count');",
  "  return { label, count };",
  "});",
  "",
].join("\n");

const PROGRAM = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: COUNTER_SOURCE }],
};

/** The route the space root's pattern ref resolves to. */
const DEFAULT_APP_PATTERN_PATH = resolveSystemPatternSource(
  DEFAULT_APP_PATTERN_SOURCE,
)!;

const ROOT_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ items?: string[] }>(({ items }) => ({ items }));",
  "",
].join("\n");

/** Serve the space root's pattern, which `ensureDefaultPattern` fetches. */
function serveRootPattern(): { restore(): void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const href = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    const url = new URL(href);
    if (url.pathname !== DEFAULT_APP_PATTERN_PATH) {
      return new Response("not found", { status: 404 });
    }
    if (url.searchParams.has("identity")) {
      const identity = await resolveEntryIdentity(
        DEFAULT_APP_PATTERN_PATH,
        (name) =>
          name === DEFAULT_APP_PATTERN_PATH
            ? Promise.resolve(ROOT_SOURCE)
            : Promise.reject(new Error(`not found: ${name}`)),
      );
      return new Response(identity, {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response(ROOT_SOURCE, {
      headers: { "content-type": "text/typescript-jsx" },
    });
  }) as typeof globalThis.fetch;
  return { restore: () => (globalThis.fetch = original) };
}

/**
 * The confidentiality a document DECLARES at its root: the store-policy
 * component (§8.12.4) as it sits in storage. Read from the stored label map
 * rather than from a display label view, because the view also carries what a
 * document merely inherits — link-carried and flow-derived components, and the
 * labels of whatever it links to — and none of those is the document's own
 * policy.
 */
function declaredRootConfidentiality(
  runtime: Runtime,
  cell: Cell<unknown>,
): readonly unknown[] {
  const link = cell.getAsNormalizedFullLink();
  const metadata = readStoredCfcMetadata(runtime.readTx(), {
    space: link.space,
    id: link.id,
    scope: link.scope,
  });
  return (metadata?.labelMap.entries ?? [])
    .filter((entry) =>
      entry.path.length === 0 &&
      (entry.origin === undefined || entry.origin === "declared")
    )
    .flatMap((entry) => entry.label.confidentiality ?? []);
}

describe("piece creation labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  async function controllerFor(session: Session): Promise<PiecesController> {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(session, runtime);
    await pieces.synced();
    return pieces;
  }

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("declares the space principal on a piece created in a named space", async () => {
    const pieces = await controllerFor(
      await createSession({
        identity: signer,
        spaceName: `creation-label-${crypto.randomUUID()}`,
      }),
    );
    const piece = await pieces.create(PROGRAM, {
      input: { label: "labeled" },
    });

    expect(declaredRootConfidentiality(runtime!, piece.getCell())).toEqual([
      { type: CFC_ATOM_TYPE.Space, id: pieces.getSpace() },
    ]);
  });

  it("declares the personal-space principal in the owner's identity space", async () => {
    const pieces = await controllerFor(
      await createSession({
        identity: signer,
        spaceDid: signer.did(),
      }),
    );
    const piece = await pieces.create(PROGRAM, {
      input: { label: "home" },
    });

    expect(declaredRootConfidentiality(runtime!, piece.getCell())).toEqual([
      { type: CFC_ATOM_TYPE.PersonalSpace, owner: signer.did() },
    ]);
  });

  it("keeps a document's own confidentiality instead of adding the space's", async () => {
    const pieces = await controllerFor(
      await createSession({
        identity: signer,
        spaceName: `creation-label-kept-${crypto.randomUUID()}`,
      }),
    );
    const carried = {
      type: CFC_ATOM_TYPE.Resource,
      class: "CreationLabelTest",
      subject: "did:example:carried",
    } as const;
    const cause = `prelabeled-${crypto.randomUUID()}`;
    const seeded = runtime!.getCell<Record<string, never>>(
      pieces.getSpace(),
      cause,
    );
    const { error } = await runtime!.editWithRetry((tx) => {
      const withTx = seeded.withTx(tx);
      withTx.set({});
      withTx.asSchema({ ifc: { confidentiality: [carried] } })
        .applyCfcSchemaToExistingValue();
    });
    expect(error).toBeUndefined();

    const piece = await pieces.create(PROGRAM, {
      input: { label: "kept" },
    }, cause);

    const clauses = declaredRootConfidentiality(runtime!, piece.getCell());
    expect(clauses).toContainEqual(carried);
    expect(clauses).not.toContainEqual(
      { type: CFC_ATOM_TYPE.Space, id: pieces.getSpace() },
    );
  });

  it("re-declares the destination's principal on a piece copied across spaces", async () => {
    // Both halves of the clone story in one case: the source space's own
    // principal is residency scoping, so the guards let the copy through
    // rather than refusing every labeled piece, and the copy comes out of
    // creation carrying the destination space's principal instead.
    const pieces = await controllerFor(
      await createSession({
        identity: signer,
        spaceName: `creation-label-clone-source-${crypto.randomUUID()}`,
      }),
    );
    const source = await pieces.create(PROGRAM, {
      input: { label: "copied" },
    });
    const destination = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `creation-label-clone-destination-${crypto.randomUUID()}`,
      }),
      runtime!,
    );
    await destination.synced();

    const clone = await source.cloneTo(destination, { copyData: true });

    expect(declaredRootConfidentiality(runtime!, clone.getCell())).toEqual([
      { type: CFC_ATOM_TYPE.Space, id: destination.getSpace() },
    ]);
    expect(await clone.input.get()).toEqual({ label: "copied" });
  });

  it("declares the space principal on the root piece", async () => {
    const server = serveRootPattern();
    try {
      const pieces = await controllerFor(
        await createSession({
          identity: signer,
          spaceName: `creation-label-root-${crypto.randomUUID()}`,
        }),
      );
      const root = await pieces.ensureDefaultPattern();

      expect(declaredRootConfidentiality(runtime!, root.getCell())).toEqual([
        { type: CFC_ATOM_TYPE.Space, id: pieces.getSpace() },
      ]);
    } finally {
      server.restore();
    }
  });

  it("declares the space principal on a recreated root piece", async () => {
    const pieces = await controllerFor(
      await createSession({
        identity: signer,
        spaceName: `creation-label-recreate-${crypto.randomUUID()}`,
      }),
    );
    const recreated = await pieces.recreateDefaultPattern({
      customProgram: {
        main: "/root.tsx",
        files: [{ name: "/root.tsx", contents: ROOT_SOURCE }],
      },
    });

    expect(declaredRootConfidentiality(runtime!, recreated.getCell())).toEqual([
      { type: CFC_ATOM_TYPE.Space, id: pieces.getSpace() },
    ]);
  });
});
