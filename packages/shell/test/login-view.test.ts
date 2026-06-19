import { assert, assertStringIncludes } from "@std/assert";
import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
} from "../src/lib/credentials.ts";

type LoginView =
  & InstanceType<
    typeof import("../src/views/LoginView.ts").XLoginView
  >
  & Record<string, unknown>;

type TemplateResultLike = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

function installBrowserGlobals(): () => void {
  const originals = new Map<string, PropertyDescriptor | undefined>();

  function setGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  class TestHTMLElement extends EventTarget {}

  setGlobal("window", globalThis);
  setGlobal("HTMLElement", TestHTMLElement);
  setGlobal("customElements", {
    define() {},
    get() {},
    whenDefined: () => Promise.resolve(),
  });
  setGlobal("document", {
    documentElement: { style: {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      append() {},
      appendChild() {},
    }),
    createTreeWalker: () => ({}),
  });
  setGlobal("devicePixelRatio", 1);
  setGlobal("screen", { deviceXDPI: 1, logicalXDPI: 1 });
  setGlobal("navigator", { platform: "", userAgent: "deno" });
  setGlobal("location", {
    protocol: "http:",
    host: "localhost:8000",
    hostname: "localhost",
    href: "http://localhost:8000/common-knowledge",
  });

  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
  };
}

function templateText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (typeof value !== "object") return "";

  const result = value as TemplateResultLike;
  return [
    ...(result.strings ?? []),
    ...((result.values ?? []).map(templateText)),
  ].join("");
}

function renderText(view: LoginView): string {
  return templateText(view.render());
}

function setState(
  view: LoginView,
  state: Record<string, unknown>,
): LoginView {
  Object.assign(view, state);
  return view;
}

Deno.test("login view renders each key store ready state", async () => {
  const restore = installBrowserGlobals();
  try {
    const { XLoginView } = await import("../src/views/LoginView.ts");
    const keyStore = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(undefined),
      clear: () => Promise.resolve(undefined),
    };

    const view = (state: Record<string, unknown> = {}) =>
      setState(new XLoginView() as LoginView, {
        keyStore,
        storedCredential: null,
        ...state,
      });

    const waitingForKeyStore = renderText(
      setState(new XLoginView() as LoginView, { storedCredential: null }),
    );
    assertStringIncludes(waitingForKeyStore, "Preparing secure storage...");
    assert(!waitingForKeyStore.includes('test-id="register-new-key"'));

    assertStringIncludes(
      renderText(view({ error: "Nope" })),
      '<div class="error">',
    );
    assertStringIncludes(
      renderText(view({ isProcessing: true })),
      "Please follow the browser's prompts to continue...",
    );
    assertStringIncludes(
      renderText(view({ mnemonic: "alpha beta gamma" })),
      "Your Secret Recovery Phrase:",
    );
    assertStringIncludes(
      renderText(view({ registrationSuccess: true })),
      "successfully registered!",
    );
    assertStringIncludes(
      renderText(view()),
      'test-id="register-new-key"',
    );
    assertStringIncludes(
      renderText(view({ flow: "register", method: null })),
      "Register with",
    );
    assertStringIncludes(
      renderText(view({
        flow: "register",
        method: AUTH_METHOD_PASSPHRASE,
      })),
      'test-id="generate-passphrase"',
    );
    assertStringIncludes(
      renderText(view({
        flow: "register",
        method: AUTH_METHOD_KEYFILE,
      })),
      "Import Key",
    );
    assertStringIncludes(
      renderText(view({
        flow: "register",
        method: AUTH_METHOD_PASSKEY,
      })),
      "Please follow the browser's prompts to continue...",
    );
  } finally {
    restore();
  }
});
