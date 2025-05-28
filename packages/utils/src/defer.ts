/**
 * Interface for a deferred promise with external resolve/reject control.
 */
export interface Deferred<T = void, E = Error> {
  resolve(value: T): void;
  reject(value?: E): void;
  promise: Promise<T>;
}
/**
 * Creates a deferred promise that can be resolved or rejected externally.
 * @returns A deferred object with resolve, reject, and promise properties
 */
export function defer<T = void, E = Error>(): Deferred<T, E> {
  let resolve;
  let reject;
  const promise: Promise<T> = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve: resolve!, reject: reject!, promise };
}
