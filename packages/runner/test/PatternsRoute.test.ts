/** Tests the patterns route over a directory of files it does not know. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { PatternsRoute } from "../src/harness/patterns-route.deno.ts";

const ENTRY = "export default 1;\n";
const IMPORTER = 'import "./leaf.ts";\nexport default 2;\n';

// Writes the named files into a fresh temp tree and returns its root. The
// caller removes the tree.
async function tree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "patterns-route-" });
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return root;
}

// Runs `body` against a route over a temp tree, then removes the tree.
async function withRoute(
  files: Record<string, string>,
  body: (route: PatternsRoute, root: string) => Promise<void>,
): Promise<void> {
  const root = await tree(files);
  try {
    await body(new PatternsRoute(root), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://host.invalid${path}`, { headers });
}

describe("PatternsRoute", () => {
  it("serves a file's source under the patterns route", async () => {
    await withRoute({ "system/main.tsx": ENTRY }, async (route) => {
      const response = await route.serve(get("/api/patterns/system/main.tsx"));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("Content-Type")).toContain(
        "text/typescript-jsx",
      );
      expect(await response?.text()).toBe(ENTRY);
    });
  });

  it("serves the entry closure's identity for `?identity`", async () => {
    await withRoute(
      { "main.tsx": IMPORTER, "leaf.ts": ENTRY },
      async (route) => {
        const response = await route.serve(
          get("/api/patterns/main.tsx?identity"),
        );
        expect(response?.status).toBe(200);
        expect(response?.headers.get("Content-Type")).toContain("text/plain");
        const identity = (await response?.text())?.trim();
        expect(identity).toBe(await route.identity("main.tsx"));
      },
    );
  });

  it("answers 304 when the request already holds the ETag", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      const first = await route.serve(get("/api/patterns/main.tsx"));
      const etag = first!.headers.get("ETag")!;
      const second = await route.serve(
        get("/api/patterns/main.tsx", { "If-None-Match": etag }),
      );
      expect(second?.status).toBe(304);
      expect(await second?.text()).toBe("");
    });
  });

  it("answers 404 for a path that names no file", async () => {
    // The three ways a path fails to name one. Each reports itself
    // differently to the read, and the route serves files, never a listing.

    await withRoute({ "system/main.tsx": ENTRY }, async (route) => {
      for (
        const path of [
          "/api/patterns/absent.tsx",
          "/api/patterns/system",
          "/api/patterns/system/main.tsx/below.ts",
        ]
      ) {
        const response = await route.serve(get(path));
        expect(response?.status).toBe(404);
      }
    });
  });

  it("answers 400 for a path that would leave the tree", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      for (
        const path of [
          "/api/patterns/..%2Fmain.tsx",
          "/api/patterns/%2Fetc%2Fpasswd",
          "/api/patterns/file:passwd",
        ]
      ) {
        const response = await route.serve(get(path));
        expect(response?.status).toBe(400);
      }
    });
  });

  it("declines a request the route does not address", async () => {
    await withRoute({ "main.tsx": ENTRY }, async (route) => {
      expect(await route.serve(get("/main.tsx"))).toBeUndefined();
      expect(await route.serve(get("/api/patterns/"))).toBeUndefined();
      expect(
        await route.serve(
          new Request("https://host.invalid/api/patterns/main.tsx", {
            method: "POST",
          }),
        ),
      ).toBeUndefined();
    });
  });

  it("serves a directory named for a prefix of its own", async () => {
    const root = await tree({ "main.tsx": ENTRY });
    const extra = await tree({ "main.tsx": IMPORTER, "leaf.ts": ENTRY });
    try {
      const route = new PatternsRoute(root, [
        { routePrefix: "connector/", directory: extra },
      ]);
      expect(await route.getText("connector/main.tsx")).toBe(IMPORTER);
      expect(await route.getText("main.tsx")).toBe(ENTRY);
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(extra, { recursive: true });
    }
  });
});
