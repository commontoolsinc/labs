import { createRouter } from "@/lib/create-app.ts";

const router = createRouter();

const BASE_TARGET_URL = "https://static.commontools.dev/jumble/latest";

router.get("/*", async (c) => {
  let proxiedUrl: string;
  const path = c.req.path;

  if (path === "/" || path === "/index.html") {
    proxiedUrl = `${BASE_TARGET_URL}/index.html`;
  } else {
    proxiedUrl = `${BASE_TARGET_URL}${path}`;
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
