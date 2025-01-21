import app from "@/app.ts";
import env from "@/env.ts";

const port = env.PORT;
// eslint-disable-next-line no-console
console.log(`Server is running on port http://localhost:${port}`);

export type AppType = typeof app;

console.log("WUATTTT", env.ENV);
if (env.ENV === "development") {
  const options = {
    port: 8443,
    cert: await Deno.readTextFile("./cert.pem"),
    key: await Deno.readTextFile("./key.pem"),
  };
  Deno.serve(options, app.fetch);
} else {
  Deno.serve(app.fetch);
}
