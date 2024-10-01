/* tslint:disable */
/* eslint-disable */

type JavaScriptValueMap = {
    [index: string]: JavaScriptValue
}

type JavaScriptShapeMap = {
    [index: string]: "string"|"boolean"|"number"|"buffer"
}

interface JavaScriptValue {
    tag: string;
    val: string|number|boolean|Uint8Array;
}

interface JavaScriptModuleDefinition {
    inputs: JavaScriptValueMap;
    outputs: JavaScriptShapeMap;
    body: string;
}


/**
* A newtype over all possible variants of things that implement [`FunctionInterface`].
* This is the concrete type that is exposed to the web browser host.
*/
export class CommonFunction {
  free(): void;
/**
* Invoke the interior function
* @param {JavaScriptValueMap} input
* @returns {Promise<JavaScriptValueMap>}
*/
  run(input: JavaScriptValueMap): Promise<JavaScriptValueMap>;
}
/**
* The [`CommonRuntime`] constitutes the JavaScript-facing bindings into
* the Common Runtime.
*/
export class CommonRuntime {
  free(): void;
/**
* Construct a new [`CommonRuntime`], passing an optional URL to a backing
* remote Runtime that will be used when instantiating and invoking remote
* modules
* @param {string | undefined} [remote_runtime_address]
*/
  constructor(remote_runtime_address?: string);
/**
* Instantiate a module given some module definition
* @param {JavaScriptModuleDefinition} definition
* @returns {Promise<CommonFunction>}
*/
  instantiate(definition: JavaScriptModuleDefinition): Promise<CommonFunction>;
}
/**
*/
export class IntoUnderlyingByteSource {
  free(): void;
/**
* @param {ReadableByteStreamController} controller
*/
  start(controller: ReadableByteStreamController): void;
/**
* @param {ReadableByteStreamController} controller
* @returns {Promise<any>}
*/
  pull(controller: ReadableByteStreamController): Promise<any>;
/**
*/
  cancel(): void;
/**
*/
  readonly autoAllocateChunkSize: number;
/**
*/
  readonly type: string;
}
/**
*/
export class IntoUnderlyingSink {
  free(): void;
/**
* @param {any} chunk
* @returns {Promise<any>}
*/
  write(chunk: any): Promise<any>;
/**
* @returns {Promise<any>}
*/
  close(): Promise<any>;
/**
* @param {any} reason
* @returns {Promise<any>}
*/
  abort(reason: any): Promise<any>;
}
/**
*/
export class IntoUnderlyingSource {
  free(): void;
/**
* @param {ReadableStreamDefaultController} controller
* @returns {Promise<any>}
*/
  pull(controller: ReadableStreamDefaultController): Promise<any>;
/**
*/
  cancel(): void;
}
/**
* An intermediate representation of a Runtime-legible value, used
* as fulcrum for transformation between plain JavaScript objects and
* strictly typed Rust [crate::Value].
*/
export class Value {
  free(): void;
/**
* Construct a new [`Value`] from a raw JavaScript value. A plain,
* un-tagged JavaScript value will be inferred, so this can be constructed
* with "just a string" or "just a number" or "just a Uint8Array" etc.
* @param {any} inner
*/
  constructor(inner: any);
/**
* A string that represents the underlying type of the value
*/
  tag: string;
/**
* The raw [JsValue] representation of the value
*/
  val: any;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_commonfunction_free: (a: number, b: number) => void;
  readonly commonfunction_run: (a: number, b: number) => number;
  readonly __wbg_value_free: (a: number, b: number) => void;
  readonly __wbg_get_value_tag: (a: number, b: number) => void;
  readonly __wbg_set_value_tag: (a: number, b: number, c: number) => void;
  readonly __wbg_get_value_val: (a: number) => number;
  readonly __wbg_set_value_val: (a: number, b: number) => void;
  readonly value_new: (a: number) => number;
  readonly __wbg_commonruntime_free: (a: number, b: number) => void;
  readonly commonruntime_new: (a: number, b: number) => number;
  readonly commonruntime_instantiate: (a: number, b: number) => number;
  readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
  readonly intounderlyingbytesource_type: (a: number, b: number) => void;
  readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
  readonly intounderlyingbytesource_start: (a: number, b: number) => void;
  readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
  readonly intounderlyingbytesource_cancel: (a: number) => void;
  readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
  readonly intounderlyingsource_pull: (a: number, b: number) => number;
  readonly intounderlyingsource_cancel: (a: number) => void;
  readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
  readonly intounderlyingsink_write: (a: number, b: number) => number;
  readonly intounderlyingsink_close: (a: number) => number;
  readonly intounderlyingsink_abort: (a: number, b: number) => number;
  readonly __wbindgen_export_0: (a: number, b: number) => number;
  readonly __wbindgen_export_1: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_2: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_3: WebAssembly.Table;
  readonly __wbindgen_export_4: (a: number, b: number, c: number) => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_5: (a: number) => void;
  readonly __wbindgen_export_6: (a: number, b: number, c: number, d: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
