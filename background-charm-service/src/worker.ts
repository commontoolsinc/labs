import { sleep } from "@commontools/utils";
import { setBobbyServerUrl, storage } from "@commontools/runner";
import { Identity } from "@commontools/identity";

let initialized = false;
async function setup(
  data: { did: string; toolshed_url: string; operator_pass: string },
) {
  const { did, toolshed_url, operator_pass } = data || {};
  if (!did) {
    throw new Error("Worker missing did");
  }
  if (!toolshed_url) {
    throw new Error("Worker missing toolshed_url");
  }
  if (!operator_pass) {
    throw new Error("Worker missing operator_pass");
  }
  storage.setRemoteStorage(new URL(toolshed_url));
  storage.setSigner(await Identity.fromPassphrase(operator_pass));
  setBobbyServerUrl(toolshed_url);

  console.log(`Worker: Initialized habitat ${did}`);
  initialized = true;
  return { setup: true };
}

async function shutdown() {
  if (!initialized) {
    throw new Error("Worker not initialized");
  }
  console.log(`Worker: Shutting down habitat`);
  await storage.synced();
  await sleep(1000);
  return { shutdown: true };
}

async function runCharm(data: { charm: string }) {
  if (!initialized) {
    throw new Error("Worker not initialized");
  }
  const { charm } = data || {};
  if (!charm) {
    throw new Error("Missing required parameter: charm");
  }

  await sleep(1000);

  console.log(`Worker: processing charm run`);
  return { success: true, charmId: charm };
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, data } = event.data || {};

  try {
    if (type === "setup") {
      const result = await setup(data);
      self.postMessage({ id, result });
    } else if (type === "runCharm") {
      const result = await runCharm(data);
      self.postMessage({ id, result });
    } else if (type === "shutdown") {
      const result = await shutdown();
      self.postMessage({ id, result });
      self.close(); // terminates the worker
    } else {
      throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error) {
    console.error(`Worker error:`, error);
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
