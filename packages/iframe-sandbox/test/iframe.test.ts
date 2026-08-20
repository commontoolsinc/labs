import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import { CommonIframeSandboxElement as _ } from "../src/common-iframe-sandbox.ts";
import {
  assert,
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

// Each guest document is one module script: this prolog, the test's own body,
// and `GUEST_EPILOG`. The prolog names the guest API's operations as the body
// uses them, so a body reads as the guest code it is.
const GUEST_PROLOG = `<script type="module">
import { connectGuestContext } from "/guest.js";

let onUpdate = (key, value) => {};
const guest = connectGuestContext((key, value) => onUpdate(key, value));
const read = (key) => guest.read(key);
const write = (key, value) => guest.write(key, value);
const subscribe = (key) => guest.subscribe(key);
const unsubscribe = (key) => guest.unsubscribe(key);
`;

const GUEST_EPILOG = `
</script>`;

Deno.test("read and writes", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ a: 1 });

    const body = GUEST_PROLOG + `
onUpdate = (key, value) => {
  if (key === "a" && value === 1) {
    write(key, value + 1); 
  }
};
read('a');
` + GUEST_EPILOG;
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
    const body = GUEST_PROLOG + `
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
` + GUEST_EPILOG;
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

    const body1 = GUEST_PROLOG + `
write("b", 1);
` + GUEST_EPILOG;

    const body2 = GUEST_PROLOG + `
onUpdate = (key, value) => {
  if (key === "b" && value === 100) {
    write("a", 200); 
  }
};
read("b");
` + GUEST_EPILOG;
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

    const body1 = GUEST_PROLOG + `
write("b", 1);
` + GUEST_EPILOG;
    const body2 = GUEST_PROLOG + `
write("c", 1);
` + GUEST_EPILOG;
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

    const body1 = GUEST_PROLOG + `
subscribe("a");
write("ready1", true);
` + GUEST_EPILOG;
    const body2 = GUEST_PROLOG + `
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
` + GUEST_EPILOG;
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

Deno.test("carries a value structured cloning would flatten", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({
      payload: new FabricBytes(new Uint8Array([1, 2, 3])),
    });

    // The guest reports the bytes it can read out of what arrived, and echoes
    // the value back. Reading them takes a live `FabricBytes`, which is what
    // separates a value that crossed whole from one structured cloning
    // stripped to a bare object; the echo asks the same of the other
    // direction. `bytes-seen` reports the flattened case rather than throwing
    // on it, so that case fails an assertion instead of going silent.
    const body = GUEST_PROLOG + `
onUpdate = (key, value) => {
  if (key !== "payload") return;
  write("bytes-seen", typeof value?.slice === "function"
    ? [...value.slice()]
    : "not a FabricBytes");
  write("echo", value);
};
read("payload");
` + GUEST_EPILOG;
    const iframe = await render(body, context);

    // `echo` is written last, and writes arrive in order, so waiting on its
    // arrival puts both reports in hand. Waiting on arrival rather than on the
    // class leaves a value that crossed flattened to fail an assertion below
    // rather than never satisfy the wait.
    await waitForContextValue(
      context,
      iframe,
      "echo",
      (value) => value !== undefined,
    );
    assertDeepEquals(context.get(iframe, "bytes-seen"), [1, 2, 3]);
    assert(context.get(iframe, "echo") instanceof FabricBytes);
    assertDeepEquals(
      [...(context.get(iframe, "echo") as FabricBytes).slice()],
      [1, 2, 3],
    );
  } finally {
    cleanupFixtures();
  }
});
