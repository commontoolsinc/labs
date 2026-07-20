import { CommonIframeSandboxElement } from "../src/common-iframe-sandbox.ts";
import { setIframeContextHandler } from "../src/index.ts";
import { defer } from "@commonfabric/utils/defer";

type Callback = (key: string, value: unknown) => void;
interface Context {
  [name: string]: unknown;
}

export class ContextShim {
  data: Context;
  callbacks: [number, string, Callback][];
  receiptIds: number;
  observers: [string, Callback][];

  constructor(object = {}) {
    this.data = object;
    this.callbacks = [];
    this.receiptIds = 0;
    this.observers = [];
  }
  set(_element: CommonIframeSandboxElement, key: string, value: unknown) {
    this.data[key] = value;
    for (let i = 0; i < this.callbacks.length; i++) {
      const [_, callback_key, callback] = this.callbacks[i];
      if (key === callback_key) {
        callback(key, value);
      }
    }
    for (const [observer_key, observer] of [...this.observers]) {
      if (key === observer_key) {
        observer(key, value);
      }
    }
  }

  // Watch writes to `key`. Observers are held apart from `subscribe`'s
  // callbacks so that a test watching a key does not consume a receipt id,
  // which would change the ids the guest's own subscriptions are given.
  observe(key: string, callback: Callback): () => void {
    const entry: [string, Callback] = [key, callback];
    this.observers.push(entry);
    return () => {
      const index = this.observers.indexOf(entry);
      if (index !== -1) {
        this.observers.splice(index, 1);
      }
    };
  }

  get(_element: CommonIframeSandboxElement, key: string): unknown {
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
      const [id] = this.callbacks[i];
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
      return (context as ContextShim).get(element, key);
    },
    write(element, context, key, value) {
      (context as ContextShim).set(element, key, value);
    },
    subscribe(element, context, key, callback) {
      return (context as ContextShim).subscribe(element, key, callback);
    },
    unsubscribe(element, context, receipt) {
      (context as ContextShim).unsubscribe(element, receipt as number);
    },
    onLLMRequest(_element, _context, _payload) {
      // Not implemented
      return Promise.resolve({});
    },
    onReadWebpageRequest(_element, _context, _payload) {
      // Not implemented
      return Promise.resolve({});
    },
    async onPerform(_element, _context, _command) {
      return await { error: new Error(`Not implemented`) };
    },
  });
}

export function assert(condition: boolean) {
  if (!condition) {
    throw new Error(`${condition} is not truthy.`);
  }
}

export function assertEquals(a: unknown, b: unknown) {
  if (a !== b) {
    throw new Error(`${a} does not equal ${b}.`);
  }
}

export function deepEquals(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function assertDeepEquals(a: unknown, b: unknown) {
  if (!deepEquals(a, b)) {
    throw new Error(
      `${JSON.stringify(a)} does not deep equal ${JSON.stringify(b)}.`,
    );
  }
}

const FIXTURE_ID = "common-iframe-csp-fixture-container";
export function cleanupFixtures() {
  for (const fixture of document.querySelectorAll(`[id^="${FIXTURE_ID}-"]`)) {
    fixture.remove();
  }
}

export function render(
  src: string,
  context = {},
): Promise<CommonIframeSandboxElement> {
  return new Promise((resolve) => {
    const parent = document.createElement("div");
    parent.id = `${FIXTURE_ID}-${(Math.random() * 1_000_000).toFixed(0)}`;
    const iframe = document.createElement(
      "common-iframe-sandbox",
    ) as CommonIframeSandboxElement;
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

export function invertPromise(promise: Promise<unknown>): Promise<unknown> {
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

// Resolves once `key`'s value in `context` satisfies `predicate`. A guest's
// write reaches the context through the handler, so observing the context
// settles the wait when the write arrives. The current value is checked first,
// for a write that already landed before the wait began.
export function waitForContextValue(
  context: ContextShim,
  element: CommonIframeSandboxElement,
  key: string,
  predicate: (value: unknown) => boolean,
): Promise<void> {
  if (predicate(context.get(element, key))) {
    return Promise.resolve();
  }
  const deferred = defer();
  const stop = context.observe(key, (_key, value) => {
    if (predicate(value)) {
      stop();
      deferred.resolve();
    }
  });
  return deferred.promise;
}
