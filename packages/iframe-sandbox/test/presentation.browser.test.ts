import { expect } from "@std/expect";

import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";

/** Returns the next report from this fixture's guest. */
function report(id: string) {
  return new Promise<Record<string, string>>((resolve) => {
    const receive = (event: MessageEvent) => {
      if (event.data?.fixture !== id) return;
      window.removeEventListener("message", receive);
      resolve(event.data);
    };
    window.addEventListener("message", receive);
  });
}

/** Returns HTML which reports its effective style and retained input. */
function guest(id: string) {
  return `<!doctype html><html data-skin="authored"><head>
    <style>body { color: var(--example-ink); }</style></head><body>
    <input value="initial"><script>
    const input = document.querySelector('input');
    const incarnation = Math.random().toString();
    function report() {
      top.postMessage({fixture: ${JSON.stringify(id)},
        color: getComputedStyle(document.body).color,
        skin: document.documentElement.getAttribute('data-skin'),
        caption: document.documentElement.getAttribute('data-caption'),
        mode: document.compatMode, input: input.value, incarnation,
        fonts: document.querySelector('link[rel="stylesheet"]')?.getAttribute('href') ?? ''
      }, '*');
    }
    window.addEventListener('load', () => { report(); input.value = 'edited'; });
    document.addEventListener('common-iframe-presentation', report);
    window.addEventListener('message', event => {
      if (event.data === 'presentation-test-probe') report();
    });
    </script></body></html>`;
}

for (const outerFrameUrl of [undefined, "/outer-frame.html"]) {
  Deno.test(`iframe presentation updates in ${outerFrameUrl ?? "srcdoc"} without replacing the guest`, async () => {
    const id = crypto.randomUUID();
    const element = new CommonIframeSandboxElement();
    element.outerFrameUrl = outerFrameUrl;
    element.presentation = {
      css: ":root { --example-ink: rgb(12, 34, 56); }",
      attributes: {
        "data-skin": "host",
        "data-caption": "</script><b>text</b>",
      },
      stylesheets: [],
    };
    element.src = guest(id);
    const first = report(id);
    document.body.append(element);
    try {
      const initial = await first;
      expect(initial.color).toBe("rgb(12, 34, 56)");
      expect(initial.skin).toBe("host");
      expect(initial.caption).toBe("</script><b>text</b>");
      expect(initial.mode).toBe("CSS1Compat");
      const changed = report(id);
      element.presentation = {
        css: ":root { --example-ink: rgb(65, 43, 21); }",
        attributes: { "data-skin": "next" },
        stylesheets: [],
      };
      const next = await changed;
      expect(next.color).toBe("rgb(65, 43, 21)");
      expect(next.skin).toBe("next");
      expect(next.input).toBe("edited");
      expect(next.incarnation).toBe(initial.incarnation);
      const guestWindow = element.accessForTestingOnly.iframeRef.value
        ?.contentWindow
        ?.frames[0];
      expect(guestWindow).toBeDefined();
      const unrelated = report(id);
      guestWindow!.postMessage({ type: "presentation", data: null }, "*");
      guestWindow!.postMessage("presentation-test-probe", "*");
      const afterUnrelated = await unrelated;
      expect(afterUnrelated.skin).toBe("next");
      expect(afterUnrelated.color).toBe(next.color);
      const cleared = report(id);
      element.presentation = null;
      const plain = await cleared;
      expect(plain.skin).toBe("authored");
      expect(plain.color).not.toBe(next.color);
      expect(plain.input).toBe("edited");
      expect(plain.incarnation).toBe(initial.incarnation);
      const reloadedID = crypto.randomUUID();
      const reloaded = report(reloadedID);
      element.src = guest(reloadedID);
      element.presentation = {
        css: ":root { --example-ink: rgb(98, 76, 54); }",
        attributes: { "data-skin": "replacement" },
        stylesheets: [],
      };
      const replacement = await reloaded;
      expect(replacement.color).toBe("rgb(98, 76, 54)");
      expect(replacement.skin).toBe("replacement");
      expect(replacement.incarnation).not.toBe(initial.incarnation);
    } finally {
      element.remove();
    }
  });
}
