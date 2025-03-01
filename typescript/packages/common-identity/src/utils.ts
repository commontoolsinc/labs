export function random(length: number): Uint8Array {
  const buffer = new Uint8Array(length);
  window.crypto.getRandomValues(buffer);
  return buffer;
}

export function bufferSourceToArrayBuffer(
  source: BufferSource,
): ArrayBuffer | SharedArrayBuffer {
  return ArrayBuffer.isView(source) ? source.buffer : source;
}

// Bind a handler to an `EventTarget`'s event once.
export function once(
  target: EventTarget,
  eventName: string,
  callback: (e: any) => any,
) {
  const wrap = (e: Event) => {
    callback(e);
    target.removeEventListener(eventName, wrap);
  };
  target.addEventListener(eventName, wrap);
}

const HASH_ALG = "SHA-256";
// Hash input via SHA-256.
export async function hash(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest(HASH_ALG, input));
}

// Clones object using Structured Clone Algorithm.
// Used to test if ed25519 keys can be stored in IndexedDB.
export function clone<T>(obj: T): Promise<T> {
  return new Promise((resolve, reject) => {
    let { port1, port2 } = new MessageChannel();
    port1.onmessage = (msg) => resolve(msg.data);
    port1.onmessageerror = (e) => reject(e);
    port2.postMessage(obj);
  });
}
