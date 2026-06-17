import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { entityIdFrom, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { slugIdForSpace } from "../../runner/src/slugs.ts";
import { InMemoryProgram } from "@commonfabric/js-compiler";
import { pinProgramFabricImports } from "../lib/fabric-deps.ts";
import { collectLocalProgram } from "../lib/dev.ts";
import { cf } from "./utils.ts";

const signer = await Identity.fromPassphrase("cli fabric deps test");
const space = signer.did();
const ENTRY = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("cli fabric deps", () => {
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

  // Write a piece cell carrying the content-addressed `patternIdentity` pointer
  // and slug-redirect to it, so the fabric ref chase resolves to its identity.
  async function writePatternSlug(slug: string): Promise<void> {
    const piece = runtime.getCell(
      space,
      { space, random: `piece-${slug}` },
    );
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "piece" });
      pieceWithTx.setMetaRaw("patternIdentity", {
        identity: ENTRY,
        symbol: "default",
      });
    });
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        piece.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  it("pins mutable fabric imports in a runtime program", async () => {
    await writePatternSlug("dep");
    const result = await pinProgramFabricImports(runtime, space, {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `import dep from "cf:dep";\nexport default dep;`,
        },
      ],
    });

    expect(result.program.files[0].contents).toBe(
      `import dep from "cf:dep@${ENTRY}";\nexport default dep;`,
    );
    expect(result.rewrites).toEqual([
      {
        file: "/main.tsx",
        specifier: "cf:dep",
        pinned: `cf:dep@${ENTRY}`,
        resolvedIdentity: ENTRY,
        line: 1,
      },
    ]);
  });

  it("pins fabric imports across every file of a program", async () => {
    await writePatternSlug("dep");
    const result = await pinProgramFabricImports(runtime, space, {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: `import { s } from "./schemas.tsx";\nexport default s;`,
        },
        {
          name: "/schemas.tsx",
          contents: `import dep from "cf:dep";\nexport const s = dep;`,
        },
      ],
    });

    expect(result.rewrites).toEqual([
      {
        file: "/schemas.tsx",
        specifier: "cf:dep",
        pinned: `cf:dep@${ENTRY}`,
        resolvedIdentity: ENTRY,
        line: 1,
      },
    ]);
    expect(result.program.files[0].contents).toContain("./schemas.tsx");
    expect(result.program.files[1].contents).toContain(`cf:dep@${ENTRY}`);
  });

  it("collectLocalProgram walks local files and dispatches on fabric refs", async () => {
    const resolver = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `import { s } from "./schemas.tsx";\nexport default s;`,
      "/schemas.tsx": `import dep from "cf:dep";\nexport const s = dep;`,
    });

    const program = await collectLocalProgram(resolver, {
      fabricImports: "allow",
    });
    expect(program.files.map((f) => f.name)).toEqual([
      "/main.tsx",
      "/schemas.tsx",
    ]);

    await expect(
      collectLocalProgram(resolver, { fabricImports: "reject" }),
    ).rejects.toThrow("fabric imports require a space context");
  });

  it("collectLocalProgram surfaces malformed fabric specifiers as parse errors", async () => {
    const resolver = new InMemoryProgram("/main.tsx", {
      "/main.tsx": `import dep from "cf:module/abc";\nexport default dep;`,
    });

    await expect(
      collectLocalProgram(resolver, { fabricImports: "allow" }),
    ).rejects.toThrow("compiler-internal namespaces");
  });

  it("exposes deps update help", async () => {
    const { code, stdout } = await cf("deps update --help");

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("--check");
  });
});
