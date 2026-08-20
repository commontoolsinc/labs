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

    const body = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "a" && value === 1) {
    write(key, value + 1); 
  }
};
read('a');
${GUEST_EPILOG}`;
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
    const body = `${GUEST_PROLOG}
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
${GUEST_EPILOG}`;
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

    const body1 = `${GUEST_PROLOG}
write("b", 1);
${GUEST_EPILOG}`;

    const body2 = `${GUEST_PROLOG}
onUpdate = (key, value) => {
  if (key === "b" && value === 100) {
    write("a", 200); 
  }
};
read("b");
${GUEST_EPILOG}`;
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

    const body1 = `${GUEST_PROLOG}
write("b", 1);
${GUEST_EPILOG}`;
    const body2 = `${GUEST_PROLOG}
write("c", 1);
${GUEST_EPILOG}`;
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

    const body1 = `${GUEST_PROLOG}
subscribe("a");
write("ready1", true);
${GUEST_EPILOG}`;
    const body2 = `${GUEST_PROLOG}
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
${GUEST_EPILOG}`;
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

Deno.test("what a guest posts outside its port raises an alarm, not a write", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim();
    const errors: string[] = [];
    const onError = (event: Event) =>
      errors.push((event as CustomEvent).detail.description);
    document.addEventListener("common-iframe-error", onError);

    // The first post is a protocol message sent the way a guest reaches its
    // parent rather than over its port. Nothing routes it there any more, so
    // it cannot become a write; it is an alarm whose contents are not an
    // error, and it is dropped. The second is the alarm a guest with no
    // working port has, which is the whole reason that route still exists.
    // The third is an ordinary write, and it lands last.
    const body = `${GUEST_PROLOG}
parent.postMessage({ type: "write", data: ["relayed", 1] }, "*");
parent.postMessage({ type: "error", data: {
  description: "raised without a port",
  source: "", lineno: 0, colno: 0, stacktrace: "",
} }, "*");
write("after", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);

    try {
      await waitForContextValue(
        context,
        iframe,
        "after",
        (value) => value === 1,
      );
      assertEquals(context.get(iframe, "relayed"), undefined);
      assertDeepEquals(errors, ["raised without a port"]);
    } finally {
      document.removeEventListener("common-iframe-error", onError);
    }
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a reattached element loads its document into the frame it gets", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim();
    const body = `${GUEST_PROLOG}
write("ran", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);

    // Detaching destroys the frame the element rendered, and reattaching gets
    // it a new one -- which reports itself ready, as the first one did. The
    // teardown lands on a later task than the removal, so the two have to be
    // told apart by a turn of the event loop rather than by adjacency.
    const parent = iframe.parentElement!;
    context.set(iframe, "ran", undefined);
    parent.remove();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    document.body.appendChild(parent);

    // The guest in the new frame runs the same document, so its write is what
    // says the element found its way back rather than going quietly mute.
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);
  } finally {
    cleanupFixtures();
  }
});

Deno.test("a second ready from the frame already in hand is refused", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim();
    const body = `${GUEST_PROLOG}
write("ran", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);

    // Reached into rather than driven, because the outer frame reports itself
    // ready once and nothing outside it can send that message: the element
    // takes it only from the window it rendered. So the refusal is asserted
    // where it is made.
    const inner = iframe as unknown as {
      iframeRef: { value?: HTMLIFrameElement };
      onOuterReady: (source: Window) => void;
      readyWindow?: Window;
    };
    const reporting = inner.iframeRef.value!.contentWindow!;
    assertEquals(inner.readyWindow, reporting);

    let refusal = "";
    try {
      inner.onOuterReady(reporting);
    } catch (error) {
      refusal = String(error);
    }
    assert(refusal.includes("Already initialized"));
  } finally {
    cleanupFixtures();
  }
});

Deno.test("an element that gets a frame and has no source says nothing is loaded", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim();
    const body = `${GUEST_PROLOG}
write("ran", 1);
${GUEST_EPILOG}`;
    const iframe = await render(body, context);
    await waitForContextValue(context, iframe, "ran", (value) => value === 1);

    // Driven rather than staged, for the reason the refusal test gives: a
    // frame reports itself ready once, and the report cannot be sent from
    // anywhere else. A window this element has not seen stands for the frame a
    // reattach would bring.
    const inner = iframe as unknown as {
      onOuterReady: (source: Window) => void;
      loadState: string;
    };
    // @ts-ignore This is a lit property.
    iframe.src = "";
    inner.onOuterReady({} as Window);
    assertEquals(inner.loadState, "");
  } finally {
    cleanupFixtures();
  }
});
