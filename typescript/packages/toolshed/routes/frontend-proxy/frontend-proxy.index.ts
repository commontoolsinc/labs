import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

const BASE_TARGET_URL = "https://static.commontools.dev/jumble/latest";

router.get("/*", async (c) => {
  const path = c.req.path;
  let proxiedUrl: string;

  // Only proxy asset files. For all other routes return index.html.
  if (path.startsWith("/assets")) {
    proxiedUrl = `${BASE_TARGET_URL}${path}`;
  } else {
    proxiedUrl = `${BASE_TARGET_URL}/index.html`;
  }

  // NOTE(jake): Leaving these here for debugging.
  // console.log("path", path);
  // console.log("proxiedUrl", proxiedUrl);
  const headers = new Headers(c.req.header());
  headers.delete("accept-encoding");

  const response = await fetch(proxiedUrl, {
    method: c.req.method,
    headers,
  });
  return response;
});

export default router;
