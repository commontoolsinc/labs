import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";
import { setIframeContextHandler } from "../src/index.ts";
import { sleep } from "@commontools/utils/sleep";

type Callback = (key: string, value: any) => void;
interface Context {
  [name: string]: any;
}

export class ContextShim {
  data: Context;
  callbacks: [number, string, Callback][];
  receiptIds: number;

  constructor(object = {}) {
    this.data = object;
    this.callbacks = [];
    this.receiptIds = 0;
  }
  set(_element: CommonIframeSandboxElement, key: string, value: any) {
    this.data[key] = value;
    for (let i = 0; i < this.callbacks.length; i++) {
      const [_, callback_key, callback] = this.callbacks[i];
      if (key === callback_key) {
        callback(key, value);
      }
    }
  }

  get(_element: CommonIframeSandboxElement, key: string): any {
    return this.data[key];
  }

  subscribe(
    _element: CommonIframeSandboxElement,
    key: string,
    callback: Callback,
  ): number {
    const id = this.receiptIds++;
    this.callbacks.push([id, key, callback]);
    return id;
  }

  unsubscribe(_element: CommonIframeSandboxElement, receipt: number) {
    for (let i = 0; i < this.callbacks.length; i++) {
      const [id, ...rest] = this.callbacks[i];
      if (id === receipt) {
        this.callbacks.splice(i, 1);
        return;
      }
    }
  }
}

export function setIframeTestHandler() {
  setIframeContextHandler({
    read(element, context, key) {
      return context.get(element, key);
    },
    write(element, context, key, value) {
      context.set(element, key, value);
    },
    subscribe(element, context, key, callback) {
      return context.subscribe(element, key, callback);
    },
    unsubscribe(element, context, receipt) {
      context.unsubscribe(element, receipt);
    },
    onLLMRequest(element, context, payload) {
      // Not implemented
      return Promise.resolve({});
    },
    onReadWebpageRequest(element, context, payload) {
      // Not implemented
      return Promise.resolve({});
    },
    async onPerform(element, context, command) {
      return await { error: new Error(`Not implemented`) };
    },
  });
}

export function assert(condition: boolean) {
  if (!condition) {
    throw new Error(`${condition} is not truthy.`);
  }
}

export function assertEquals(a: any, b: any) {
  if (a !== b) {
    throw new Error(`${a} does not equal ${b}.`);
  }
}

const FIXTURE_ID = "common-iframe-csp-fixture-container";
export function render(src: string, context = {}): Promise<CommonIframeSandboxElement> {
  return new Promise((resolve) => {
    const parent = document.createElement("div");
    parent.id = `${FIXTURE_ID}-${(Math.random() * 1_000_000).toFixed(0)}`;
    const iframe = document.createElement("common-iframe-sandbox") as CommonIframeSandboxElement;
    // @ts-ignore This is a lit property.
    iframe.context = context;
    iframe.addEventListener("load", (_) => {
      resolve(iframe);
    });
    parent.appendChild(iframe);
    document.body.appendChild(parent);
    // @ts-ignore This is a lit property.
    iframe.src = src;
  });
}

export function invertPromise(promise: Promise<any>): Promise<any> {
  return new Promise((resolve, reject) => promise.then(reject, resolve));
}

export function waitForEvent(
  element: HTMLElement,
  eventName: string,
  timeout = 1000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(`Timeout reached waiting for ${eventName}`);
    }, timeout);
    const handler = (e: Event) => {
      element.removeEventListener(eventName, handler);
      clearTimeout(timer);
      resolve(e);
    };
    element.addEventListener(eventName, handler);
  });
}

export async function waitForCondition(
  condition: () => boolean,
  tries = 10,
  timeout = 100,
) {
  while (tries-- > 0) {
    if (condition()) {
      return;
    }
    await sleep(timeout);
  }
  throw new Error("waitForCondition tries exhausted");
}
