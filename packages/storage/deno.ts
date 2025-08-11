import { handleWs } from "./src/ws/server.ts";

// Minimal dev server for Storage WS v2
Deno.serve({
  port: parseInt(Deno.env.get("PORT") ?? "8002"),
  hostname: Deno.env.get("HOST") ?? "0.0.0.0",
}, (req) => {
  const url = new URL(req.url);
  // Route: /api/storage/new/v2/:space/ws
  const m = url.pathname.match(/^\/api\/storage\/new\/v2\/(.+)\/ws$/);
  if (m && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const spaceId = decodeURIComponent(m[1]);
    return handleWs(req, spaceId);
  }
  return new Response("Not Found", { status: 404 });
});
