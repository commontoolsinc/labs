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
  set(key: string, value: any) {
    this.data[key] = value;
    for (let i = 0; i < this.callbacks.length; i++) {
      const [_, callback_key, callback] = this.callbacks[i];
      if (key === callback_key) {
        callback(key, value);
      }
    }
  }

  get(key: string): any {
    return this.data[key];
  }

  subscribe(key: string, callback: Callback): number {
    const id = this.receiptIds++;
    this.callbacks.push([id, key, callback]);
    return id;
  }

  unsubscribe(receipt: number) {
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
    read(context, key) {
      return context.get(key);
    },
    write(context, key, value) {
      context.set(key, value);
    },
    subscribe(context, key, callback) {
      return context.subscribe(key, callback);
    },
    unsubscribe(context, receipt) {
      context.unsubscribe(receipt);
    },
    onLLMRequest(context, payload) {
      // Not implemented
      return Promise.resolve({});
    },
    onReadWebpageRequest(context, payload) {
      // Not implemented
      return Promise.resolve({});
    },
    async onPerform(context, command) {
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
export function render(src: string, context = {}): Promise<HTMLElement> {
  return new Promise((resolve) => {
    const parent = document.createElement("div");
    parent.id = `${FIXTURE_ID}-${(Math.random() * 1_000_000).toFixed(0)}`;
    const iframe = document.createElement("common-iframe-sandbox");
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
