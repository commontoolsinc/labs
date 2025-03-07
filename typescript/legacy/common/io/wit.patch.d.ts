declare module 'common:io/state@0.0.1' {
  export function read(name: String): Reference | undefined;
  export function write(name: String, value: Value): void;
  export { Stream };
  export function subscribe(name: String): Stream | undefined;
}
