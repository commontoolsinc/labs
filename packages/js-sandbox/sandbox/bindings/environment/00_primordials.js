// A collection of native references to store
// before introducing user-code to ensure the host
// is calling the original values.
//
// Primordials are used mainly in two ways:
// * Provided to other injected environment scripts
//   (e.g. FunctionBind for binding console methods)
// * Invoked by host to marshall types between environments
//   (e.g. using the VM's Uint8Array to pass a typed array
//   into the VM)
(() => {
  const IpcSend = __ipc.send;

  // From (both) Deno and Node, they maintain very similar collection of
  // primordials. We use the `uncurryThis` utility to handle Function.prototype.bind
  // for now.
  // https://github.com/nodejs/node/blob/f1a8f447d7363e9a5e1c412c1a425a9771bc691f/lib/internal/per_context/primordials.js
  //
  // `uncurryThis` is equivalent to `func => Function.prototype.call.bind(func)`.
  // It is using `bind.bind(call)` to avoid using `Function.prototype.bind`
  // and `Function.prototype.call` after it may have been mutated by users.
  const { bind, call } = Function.prototype;
  const uncurryThis = bind.bind(call);

  const FunctionBind = uncurryThis(Function.prototype.bind);
  const ObjectCreate = Object.create;
  const ObjectFreeze = Object.freeze;
  const Uint8ArrayConstructor = Uint8Array;

  return {
    IpcSend,

    FunctionBind,
    NewUint8Array: (...args) => new Uint8ArrayConstructor(...args),
    ObjectCreate,
    ObjectFreeze,
  };
})();
