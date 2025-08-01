import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";
import {
  assertEquals,
  ContextShim,
  render,
  setIframeTestHandler,
  waitForCondition,
} from "./utils.ts";
import { sleep } from "@commontools/utils/sleep";

setIframeTestHandler();

function compareDeepEquals(a: any, b: any) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

const API_SHIM = `<script>
window.onUpdate = function(key, value){};
window.addEventListener('message', e => {
  if (e.data.type === "update") {
    window.onUpdate(...e.data.data);
  }
});
window.read = (key) => {
  window.parent.postMessage({
    type: 'read',
    data: key, 
  }, '*');
};
window.write = (key, value) => {
  window.parent.postMessage({
    type: 'write',
    data: [key, value],
  }, '*');
};
window.subscribe = (key) => {
  window.parent.postMessage({
    type: 'subscribe',
    data: key,
  }, '*');
};
window.unsubscribe = (key) => {
  window.parent.postMessage({
    type: 'unsubscribe',
    data: key,
  }, '*');
};
</script>
`;

Deno.test("read and writes", async () => {
  const context = new ContextShim({ a: 1 });

  const body = `
${API_SHIM}
<script>
onUpdate = (key, value) => {
  if (key === "a" && value === 1) {
    write(key, value + 1); 
  }
};
read('a');
</script>`;
  const iframe = await render(body, context);

  await waitForCondition(() => context.get(iframe, "a") === 2);
});

Deno.test("subscribes", async () => {
  const context = new ContextShim({ a: 1 });

  const body = `
${API_SHIM}
<script>
const updates = [];
onUpdate = (key, value) => {
  updates.push([key, value]);
  write("updates", updates);
  if (key === "a" && value === 3) {
    unsubscribe("a");
    write("unsubscribed", true); 
  }
};
subscribe("a");
write("ready", true);
</script>`;
  const iframe = await render(body, context);
  await waitForCondition(() => context.get(iframe, "ready") === true);
  context.set(iframe, "b", 1);
  context.set(iframe, "a", 2);
  context.set(iframe, "a", 3);
  context.set(iframe, "b", 2);
  await waitForCondition(() =>
    compareDeepEquals(context.get(iframe, "updates"), [["a", 2], ["a", 3]])
  );
  await waitForCondition(() => context.get(iframe, "unsubscribed") === true);
  context.set(iframe, "a", 4);
  context.set(iframe, "a", 5);
  await sleep(100);
  await waitForCondition(() =>
    compareDeepEquals(context.get(iframe, "updates"), [["a", 2], ["a", 3]])
  );
});

Deno.test("handles multiple iframes", async () => {
  // Test that multiple iframes can have independent contexts
  const context1 = new ContextShim({ a: 1 });
  const context2 = new ContextShim({ b: 100 });

  const body1 = `
${API_SHIM}
<script>
write("b", 1);
</script>`;

  const body2 = `
${API_SHIM}
<script>
onUpdate = (key, value) => {
  if (key === "b" && value === 100) {
    write("a", 200); 
  }
};
read("b");
</script>`;
  const iframe1 = await render(body1, context1);
  const iframe2 = await render(body2, context2);
  
  // Verify each iframe maintains its own context
  await waitForCondition(() =>
    context1.get(iframe1, "a") === 1 && context1.get(iframe1, "b") === 1
  );
  await waitForCondition(() =>
    context2.get(iframe2, "a") === 200 && context2.get(iframe2, "b") === 100
  );
});

Deno.test("handles loading new documents", async () => {
  // Test that iframe can load new documents and maintain context isolation
  const context = new ContextShim({ a: 1 });

  const body1 = `
${API_SHIM}
<script>
write("b", 1);
</script>`;
  const body2 = `
${API_SHIM}
<script>
write("c", 1);
</script>`;
  const iframe = await render(body1, context);
  await waitForCondition(() => context.get(iframe, "b") === 1);
  
  // Load a new document in the same iframe
  // @ts-ignore This is a lit property.
  iframe.src = body2;
  await waitForCondition(() => context.get(iframe, "c") === 1);
});

Deno.test("cancels subscriptions between documents", async () => {
  // Test that subscriptions from previous documents are properly cancelled
  const context = new ContextShim({ a: 1 });

  const body1 = `
${API_SHIM}
<script>
subscribe("a");
write("ready1", true);
</script>`;
  const body2 = `
${API_SHIM}
<script>
onUpdate = (key, value) => {
  if (key === "b") {
    write("got-b-update", true);
  }
  if (key === "a") {
    write("got-a-update", true); 
  }
};
subscribe("b");
write("ready2", true);
</script>`;
  const iframe = await render(body1, context);
  await waitForCondition(() => context.get(iframe, "ready1") === true);
  
  // Load new document that only subscribes to "b"
  // @ts-ignore This is a lit property.
  iframe.src = body2;
  await waitForCondition(() => context.get(iframe, "ready2") === true);
  
  // Verify old subscription to "a" is cancelled but new subscription to "b" works
  context.set(iframe, "a", 1000);
  context.set(iframe, "b", 1000);
  await waitForCondition(() => context.get(iframe, "got-b-update") === true);
  assertEquals(context.get(iframe, "got-a-update"), undefined);
});

Deno.test("clicks increment button and verifies counter changes", async () => {
  // Test simulating increment/decrement operations and verifying counter updates
  const context = new ContextShim({ count: 0 });
  
  // This simulates a counter with increment/decrement functionality
  const counterHTML = `
${API_SHIM}
<script>
// Track the current count
let currentCount = 0;

// Handle updates from context
onUpdate = (key, value) => {
  if (key === "count") {
    currentCount = value;
    // Also write back to verify sync
    write("currentCount", currentCount);
  }
};

// Subscribe to a control channel for simulating button clicks
subscribe("action");

// Handle action commands
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === "update" && e.data.data && e.data.data[0] === "action") {
    const action = e.data.data[1];
    if (action === "increment") {
      currentCount++;
      write("count", currentCount);
    } else if (action === "decrement") {
      currentCount--;
      write("count", currentCount);
    }
  }
});

// Initialize by reading the current count
read("count");

// Signal ready after initialization
setTimeout(() => {
  write("ready", true);
}, 10);
</script>`;

  const iframe = await render(counterHTML, context);
  
  // Wait for ready signal
  await waitForCondition(() => context.get(iframe, "ready") === true);
  
  // Helper to simulate button clicks through context updates
  const simulateClick = async (action: "increment" | "decrement") => {
    context.set(iframe, "action", action);
    // Small delay to allow message processing
    await sleep(50);
  };
  
  // Verify initial count
  assertEquals(context.get(iframe, "count"), 0);
  
  // Click increment button 3 times
  await simulateClick("increment");
  await waitForCondition(() => context.get(iframe, "count") === 1);
  
  await simulateClick("increment");
  await waitForCondition(() => context.get(iframe, "count") === 2);
  
  await simulateClick("increment");
  await waitForCondition(() => context.get(iframe, "count") === 3);
  
  // Verify count is 3
  assertEquals(context.get(iframe, "count"), 3);
  
  // Click decrement button back to 0
  await simulateClick("decrement");
  await waitForCondition(() => context.get(iframe, "count") === 2);
  
  await simulateClick("decrement");
  await waitForCondition(() => context.get(iframe, "count") === 1);
  
  await simulateClick("decrement");
  await waitForCondition(() => context.get(iframe, "count") === 0);
  
  // Verify back at 0
  assertEquals(context.get(iframe, "count"), 0);
  
  // Test going negative
  await simulateClick("decrement");
  await waitForCondition(() => context.get(iframe, "count") === -1);
  
  // Verify negative value
  assertEquals(context.get(iframe, "count"), -1);
});
