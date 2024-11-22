import { Hybrid } from "synopsys";

console.log("Worker started", Hybrid);

// sw.js
const SW_VERSION = "1.0.0";

self.addEventListener("message", (event) => {
  if (event.data.type === "GET_VERSION") {
    event.ports[0].postMessage(SW_VERSION);
  }
});
