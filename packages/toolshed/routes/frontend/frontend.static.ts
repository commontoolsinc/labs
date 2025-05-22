import { exists } from "@std/fs";
import * as path from "@std/path";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppBindings } from "@/lib/types.ts";
import { getMimeType } from "@/lib/mime-type.ts";

type CachedValue = {
  mimeType: string;
  buffer: Uint8Array;
};

class FrontendCache {
  private staticRoot: string;
  private cache: Map<string, CachedValue>;
  constructor(staticRoot: string) {
    this.staticRoot = staticRoot;
    this.cache = new Map();
  }

  async resolve(reqPath: string): Promise<CachedValue> {
    const cached = this.cache.get(reqPath);
    if (cached) {
      return cached;
    }
    const staticPath = path.join(this.staticRoot, reqPath);
    if (await exists(staticPath, { isFile: true })) {
      const buffer = await Deno.readFile(staticPath);
      const mimeType = getMimeType(reqPath);
      const rep = { mimeType, buffer };
      this.cache.set(reqPath, rep);
      return rep;
    } else {
      return this.resolve("/index.html");
    }
  }
}

export const applyStatic = (
  projectRoot: string,
  router: OpenAPIHono<AppBindings>,
) => {
  const cache = new FrontendCache(path.join(projectRoot, "jumble-frontend"));

  router.get("/*", async (c) => {
    let reqPath = c.req.path;
    if (reqPath === "/") {
      reqPath = "/index.html";
    }

    const { mimeType, buffer } = await cache.resolve(reqPath);
    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
      },
    });
  });
};
