import app from "@/app.ts";
import env from "@/env.ts";
import * as Sentry from "@sentry/deno";
import { Identity } from "@commontools/identity";
import { storage } from "@commontools/runner";

const port = env.PORT;

// Initialize storage with signer
const initializeStorage = async () => {
  try {
    console.log("Initializing storage signer...");
    const signer = await Identity.fromPassphrase(env.IDENTITY_PASSPHRASE);
    storage.setSigner(signer);
    storage.setRemoteStorage(new URL(env.MEMORY_URL));
    console.log("Storage signer initialized successfully");
  } catch (error) {
    console.error("Failed to initialize storage signer:", error);
    throw error;
  }
};

export type AppType = typeof app;

// Initialize and start the server
const startServer = async () => {
  // Initialize signer before starting server
  await initializeStorage();

  console.log(`Server is running on port http://localhost:${port}`);

  Sentry.init({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
  });

  Deno.serve({ port }, app.fetch);
};

// Start server and handle errors
startServer().catch((error) => {
  console.error("Failed to start server:", error);
  Deno.exit(1);
});
