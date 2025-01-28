import { ContextShim, setIframeTestHandler, cleanup, render } from "./utils.js";

setIframeTestHandler();

describe("common-iframe API", () => {
  afterEach(cleanup);

  it("read and writes", async () => {
    let context = new ContextShim({ a: 1 });

    const body = `
<script>
window.addEventListener('message', e => {
  let { type, data: [key, value] } = e.data;
  if (type === "update" && key === "a") {
    window.parent.postMessage({
      type: 'write',
      data: [key, value + 1,]
    })
  } 
});
window.parent.postMessage({
  type: 'read',
  data: 'a',
}, '*');
</script>
      `;
    const _iframe = await render(body, context);

    let tries = 10;
    while (tries-- > 0) {
      if (context.get("a") === 2) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
});