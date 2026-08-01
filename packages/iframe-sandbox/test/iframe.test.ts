import { CommonIframeSandboxElement as _ } from "../src/common-iframe-sandbox.ts";
import {
  assertDeepEquals,
  assertEquals,
  cleanupFixtures,
  ContextShim,
  deepEquals,
  render,
  setIframeTestHandler,
  waitForContextValue,
} from "./utils.ts";

setIframeTestHandler();

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
  cleanupFixtures();
  try {
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

    await waitForContextValue(context, iframe, "a", (value) => value === 2);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("subscribes", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 });

    // "barrier" stays subscribed after "a" is unsubscribed, so a write to it
    // can be used to mark a point in the update stream. It reports arrivals
    // under its own key to leave `updates` holding only what the test asserts
    // on.
    const body = `
${API_SHIM}
<script>
const updates = [];
onUpdate = (key, value) => {
  if (key === "barrier") {
    write("barrier-seen", value);
    return;
  }
  updates.push([key, value]);
  write("updates", updates);
  if (key === "a" && value === 3) {
    unsubscribe("a");
    write("unsubscribed", true);
  }
};
subscribe("a");
subscribe("barrier");
write("ready", true);
</script>`;
    const iframe = await render(body, context);
    await waitForContextValue(
      context,
      iframe,
      "ready",
      (value) => value === true,
    );
    context.set(iframe, "b", 1);
    context.set(iframe, "a", 2);
    context.set(iframe, "a", 3);
    context.set(iframe, "b", 2);
    await waitForContextValue(
      context,
      iframe,
      "updates",
      (value) => deepEquals(value, [["a", 2], ["a", 3]]),
    );
    await waitForContextValue(
      context,
      iframe,
      "unsubscribed",
      (value) => value === true,
    );

    // Writes to "a" after the unsubscribe must not reach the guest. Write to
    // the still-subscribed "barrier" afterwards and wait for the guest to
    // report it: messages are delivered in order, so once the barrier has been
    // seen, an "a" update would already have arrived had one been sent.
    context.set(iframe, "a", 4);
    context.set(iframe, "a", 5);
    context.set(iframe, "barrier", 1);
    await waitForContextValue(
      context,
      iframe,
      "barrier-seen",
      (value) => value === 1,
    );
    assertDeepEquals(context.get(iframe, "updates"), [["a", 2], ["a", 3]]);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("handles multiple iframes", async () => {
  cleanupFixtures();
  try {
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
    // Each frame writes one key: iframe1 writes "b" into context1, and iframe2
    // answers its read of "b" by writing "a" into context2. Waiting for both
    // writes puts each frame past the point where a write to the wrong context
    // would have happened, so the untouched keys can then be checked for the
    // value they started with.
    await waitForContextValue(context1, iframe1, "b", (value) => value === 1);
    await waitForContextValue(context2, iframe2, "a", (value) => value === 200);
    assertEquals(context1.get(iframe1, "a"), 1);
    assertEquals(context2.get(iframe2, "b"), 100);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("handles loading new documents", async () => {
  cleanupFixtures();
  try {
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
    await waitForContextValue(context, iframe, "b", (value) => value === 1);
    // @ts-ignore This is a lit property.
    iframe.src = body2;
    await waitForContextValue(context, iframe, "c", (value) => value === 1);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("cancels subscriptions between documents", async () => {
  cleanupFixtures();
  try {
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
    await waitForContextValue(
      context,
      iframe,
      "ready1",
      (value) => value === true,
    );
    // @ts-ignore This is a lit property.
    iframe.src = body2;
    await waitForContextValue(
      context,
      iframe,
      "ready2",
      (value) => value === true,
    );
    // "a" is written first, so by the time the guest reports the "b" update it
    // subscribed to, an "a" update from the previous document's subscription
    // would already have arrived had it survived the load.
    context.set(iframe, "a", 1000);
    context.set(iframe, "b", 1000);
    await waitForContextValue(
      context,
      iframe,
      "got-b-update",
      (value) => value === true,
    );
    assertEquals(context.get(iframe, "got-a-update"), undefined);
  } finally {
    cleanupFixtures();
  }
});
