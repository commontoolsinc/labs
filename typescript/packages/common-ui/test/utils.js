import { IframeIPC } from "../lib/src/index.js";

export class ContextShim {
  constructor(object = {}) {
    this.data = object;
    this.callbacks = [];
    this.receiptIds = 0;
  }
  set(key, value) {
    this.data[key] = value;
    for (let i = 0; i < this.callbacks.length; i++) {
      let [_, callback_key, callback] = this.callbacks[i];
      if (key === callback_key) {
        callback(key, value);
      }
    }
  }
  get(key) {
    return this.data[key];
  }
  subscribe(key, callback) {
    let id = this.receiptIds++;
    this.callbacks.push([id, key, callback]);
    return id;
  }
  unsubscribe(receipt) {
    for (let i = 0; i < this.callbacks.length; i++) {
      let [id, ...rest] = this.callbacks[i];
      if (id === receipt) {
        this.callbacks.splice(i, 1);
        return;
      }
    }
  }
}

export function setIframeTestHandler() {
  IframeIPC.setIframeContextHandler({
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
    }
  });
}

export function assert(condition) {
  if (!condition) {
    throw new Error(`${condition} is not truthy.`);
  }
}

export function assertEquals(a, b) {
  if (a !== b) {
    throw new Error(`${a} does not equal ${b}.`);
  }
}

const FIXTURE_ID = "common-iframe-csp-fixture-container";
export function render(src, context = {}) {
  return new Promise(resolve => {
    const parent = document.createElement('div');
    parent.id = FIXTURE_ID;
    const iframe = document.createElement('common-iframe');
    iframe.context = context;
    iframe.addEventListener('load', e => {
      resolve(iframe);
    })
    parent.appendChild(iframe);
    document.body.appendChild(parent);
    iframe.src = src;
  });
}

export function cleanup() {
  const parent = document.querySelector(`#${FIXTURE_ID}`);
  document.body.removeChild(parent);
}

export function invertPromise(promise) {
  return new Promise((resolve, reject) => promise.then(reject, resolve))
}

export function waitForEvent(element, eventName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      reject(`Timeout reached waiting for ${eventName}`)
    }, timeout);
    let handler = e => {
      element.removeEventListener(eventName, handler);
      clearTimeout(timer);
      resolve(e);
    };
    element.addEventListener(eventName, handler);
  });
}

export async function waitForCondition(condition, tries = 10, timeout = 100) {
  while (tries-- > 0) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitForCondition tries exhausted");
}