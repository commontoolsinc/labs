import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

// NOTE(jake): the cdn maintains /latest as the most recent build.
router.get("/app/:gitsha/*", async (c) => {
  const { gitsha } = c.req.param();

  // Separate pathname and query string.
  const [pathname, search] = c.req.url.split("?");
  const queryStr = search ? `?${search}` : "";

  // Helper to detect assets by checking for an extension in the last segment.
  const isAsset = (url: string) => {
    const cleanUrl = url.split("?")[0];
    return /\.[a-zA-Z0-9]+$/.test(cleanUrl);
  };

  // Redirect to add a trailing slash if missing on a directory request.
  // Only trigger if we're NOT serving an asset.
  if (!pathname.endsWith("/") && !isAsset(pathname)) {
    return new Response(null, {
      status: 302,
      headers: { "Location": `${pathname}/${queryStr}` },
    });
  }

  // Remove the "/app/:gitsha" prefix from the requested path.
  let path = c.req.path.replace(new RegExp(`^/app/${gitsha}`), "");

  // If the path is empty or just "/" then serve index.html.
  if (path === "" || path === "/") {
    path = "/index.html";
  }

  // Build the target URL for the CDN.
  const targetUrl =
    `https://static.commontools.dev/lookslike-high-level/${gitsha}${path}${queryStr}`;

  // Proxy the request with the original method and headers.
  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers: c.req.header(),
  });

  return response;
});

export default router;
