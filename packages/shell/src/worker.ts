// Dummy worker script for testing multi-entry build
self.onmessage = (e: MessageEvent) => {
  console.log("Worker received:", e.data);
  self.postMessage({ received: e.data });
};

console.log("Worker initialized");
