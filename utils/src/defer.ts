export interface Deferred<T, E extends Error> {
  resolve(value: T): void;
  reject(value?: E): void;
  promise: Promise<T>;
}
export function defer<T, E extends Error>(): Deferred<T, E> {
  let resolve;
  let reject;
  const promise: Promise<T> = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve: resolve!, reject: reject!, promise };
}
