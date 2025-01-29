import { waitForCondition, ContextShim, setIframeTestHandler, cleanup, render } from "./utils.js";

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
});