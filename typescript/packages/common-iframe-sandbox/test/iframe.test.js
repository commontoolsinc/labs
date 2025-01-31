import { waitForCondition, assertEquals, ContextShim, setIframeTestHandler, cleanup, render } from "./utils.js";

setIframeTestHandler();

function compareDeepEquals(a, b) {
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
describe("common-iframe API", () => {
  afterEach(cleanup);

  it("read and writes", async () => {
    let context = new ContextShim({ a: 1 });

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
    const _iframe = await render(body, context);

    await waitForCondition(() => context.get("a") === 2);
  });

  it("subscribes", async () => {
    let context = new ContextShim({ a: 1 });

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
    const _iframe = await render(body, context);
    await waitForCondition(() => context.get("ready") === true);
    context.set("b", 1);
    context.set("a", 2);
    context.set("a", 3);
    context.set("b", 2);
    await waitForCondition(() => compareDeepEquals(context.get("updates"), [["a", 2], ["a", 3]]));
    await waitForCondition(() => context.get("unsubscribed") === true);
    context.set("a", 4);
    context.set("a", 5);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await waitForCondition(() => compareDeepEquals(context.get("updates"), [["a", 2], ["a", 3]]));
  });
  
  it("handles multiple iframes", async () => {
    let context1 = new ContextShim({ a: 1 });
    let context2 = new ContextShim({ b: 100 });

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
    const _iframe1 = await render(body1, context1);
    const _iframe2 = await render(body2, context2);
    await waitForCondition(() => context1.get("a") === 1 && context1.get("b") === 1);
    await waitForCondition(() => context2.get("a") === 200 && context2.get("b") === 100);
  });

  it("handles loading new documents", async () => {
    let context = new ContextShim({ a: 1 });

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
    await waitForCondition(() => context.get("b") === 1);
    iframe.src = body2; 
    await waitForCondition(() => context.get("c") === 1);
  });
  
  it("cancels subscriptions between documents", async () => {
    let context = new ContextShim({ a: 1 });

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
    await waitForCondition(() => context.get("ready1") === true);
    iframe.src = body2; 
    await waitForCondition(() => context.get("ready2") === true);
    context.set("a", 1000);
    context.set("b", 1000);
    await waitForCondition(() => context.get("got-b-update") === true);
    assertEquals(context.get("got-a-update"), undefined);
  });
});