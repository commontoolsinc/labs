import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

// NOTE(jake): the cdn maintains /latest as the most recent build.
router.get("/app/:gitsha/*", async (c) => {
  // If no trailing slash is provided (i.e. the path is empty), redirect to force it.
  if (!c.req.url.endsWith("/")) {
    const queryStr = c.req.url.includes("?")
      ? c.req.url.substring(c.req.url.indexOf("?"))
      : "";
    return new Response(null, {
      status: 302,
      headers: { "Location": `${c.req.url}/` },
    });
  }

  const { gitsha } = c.req.param();

  // Remove the "/app/:gitsha" prefix from the requested path
  let path = c.req.path.replace(new RegExp(`^/app/${gitsha}`), "");

  // Default to index.html if root is requested
  if (path === "" || path === "/") {
    path = "/index.html";
  }

  // Preserve any query parameters
  const queryStr = c.req.url.includes("?")
    ? c.req.url.substring(c.req.url.indexOf("?"))
    : "";

  // Use the provided gitsha to target the correct folder on the CDN
  const targetUrl =
    `https://static.commontools.dev/lookslike-high-level/${gitsha}${path}${queryStr}`;

  // Proxy the request to the CDN, preserving HTTP method and headers
  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers: c.req.header(),
  });
  return response;
});

export default router;
