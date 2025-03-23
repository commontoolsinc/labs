import { sleep } from "@commontools/utils";

self.onmessage = async (event: MessageEvent) => {
  const { id, type, data } = event.data || {};

  if (type === "init") {
    const { did } = data || {};
    console.log(`Worker: Initialized habitat ${did}`);
  }

  if (type === "runCharm") {
    try {
      // Simulate some work (or run your actual charm logic here)
      await sleep(1000);
      console.log(`Worker: Running charm ${data.charm}`);
      // Return a success result
      self.postMessage({
        id,
        result: { success: true, charmId: data.charm },
      });
    } catch (error) {
      self.postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (type === "shutdown") {
    // Optionally perform cleanup here
    self.postMessage({ id, result: { shutdown: true } });
    self.close(); // terminates the worker
  }
};
