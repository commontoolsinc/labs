import { apiReference } from "@scalar/hono-api-reference";

import type { AppOpenAPI } from "@/lib/types.ts";

export default function configureOpenAPI(app: AppOpenAPI) {
  app.doc("/doc", {
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "Toolshed API",
    },
  });

  app.get(
    "/reference",
    apiReference({
      // theme: "kepler",
      defaultHttpClient: {
        targetKey: "node",
        clientKey: "fetch",
      },
      spec: {
        url: "/doc",
      },
    }),
  );
}
