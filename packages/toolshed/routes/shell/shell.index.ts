import { exists } from "@std/fs";
import ports from "@commonfabric/ports" with { type: "json" };
import * as path from "@std/path";
import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import env from "@/env.ts";
import {
  createShellStaticRouter,
  StaticResponse,
} from "@/routes/shell/shell-static.ts";

export { createShellStaticRouter, StaticResponse };

const router = createRouter();

router.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

// Keep the served shell document NON-cross-origin-isolated.
//
// The shell hosts untrusted user programs ("patterns") inside this same page,
// sandboxed with SES. A core Spectre-class defense is that pattern code cannot
// build a high-resolution timer: SharedArrayBuffer / Atomics and an un-clamped
// performance.now() are unavailable. In a browser those primitives are gated
// behind `crossOriginIsolated === true`, which a page only earns when it is
// served with both `Cross-Origin-Opener-Policy: same-origin` AND
// `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
//
// We deliberately serve neither isolating combination so `crossOriginIsolated`
// stays false. This is defense-in-depth on top of the SES taming: even if that
// taming ever regressed, a non-isolated page still hands patterns no parallel
// counter and no fine clock. We accept forgoing browser-process isolation
// against cross-origin Spectre because our threat is untrusted code inside our
// own origin, not other origins attacking us.
//
// COOP is set to the non-isolating `same-origin-allow-popups`, and COEP is
// pinned to `unsafe-none`. These run after the handler so they override any
// header an upstream change might set. See
// docs/specs/sandboxing/cross-origin-isolation.md.
router.use("/*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  c.header("Cross-Origin-Embedder-Policy", "unsafe-none");
});

const dirname = import.meta?.dirname;
if (!dirname) {
  throw new Error("File does not have dirname in toolshed.");
}
const projectRoot = path.join(dirname, "..", "..");
const shellStaticRoot = path.join(
  projectRoot,
  env.ENV === "production" ? "shell-frontend" : "shell-frontend-dev",
);
const COMPILED = await exists(path.join(projectRoot, "COMPILED"));
const SHELL_URL = Deno.env.get("SHELL_URL");

if (COMPILED) {
  // Production mode - serve static files
  router.route("/", createShellStaticRouter(shellStaticRoot));
} else if (SHELL_URL) {
  // Development mode with proxy

  // Handle root-level resources that shell app requests
  router.get("/DEV_SOCKET.js", async (_) => {
    return await fetch(`${SHELL_URL}/DEV_SOCKET.js`);
  });

  router.get("/scripts/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/styles/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/assets/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/*", async (c) => {
    const reqPath = c.req.path || "/";
    const targetUrl = `${SHELL_URL}${reqPath}`;

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: c.req.header(),
      });

      return response;
    } catch (_) {
      return c.text(
        `Failed to proxy to ${targetUrl}. Is the shell dev server running?`,
        502,
      );
    }
  });
} else {
  // Development mode without proxy
  router.get("/*", (c) => {
    return c.text(
      `Shell app not available. Set SHELL_URL=http://localhost:${ports.shell} or run the compiled binary`,
      404,
    );
  });
}

export default router;
