/* tslint:disable */
/* eslint-disable */
/**
 * The [`CtStore`] provides direct access to the underlying web store.
 */
export class CTStore {
  free(): void;
  /**
   * Create a new [`CtStore`].
   */
  constructor(db_name: string, store_name: string, hash?: Uint8Array);
  /**
   * Returns the root hash of the storage, if it contains data.
   */
  hash(): Uint8Array | undefined;
  /**
   * Sets `key` to `value`.
   */
  set(key: Uint8Array, value: Uint8Array): Promise<void>;
  /**
   * Retrieves value with `key`.
   */
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  /**
   * Calls `callback` with `key` and `value` arguments
   * for each entry within `start` and `end` range.
   */
  getRange(start: Uint8Array, end: Uint8Array, start_inclusive: boolean, end_inclusive: boolean, callback: Function): Promise<void>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_ctstore_free: (a: number, b: number) => void;
  readonly ctstore_new: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly ctstore_hash: (a: number, b: number) => void;
  readonly ctstore_set: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly ctstore_get: (a: number, b: number, c: number) => number;
  readonly ctstore_getRange: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
  readonly __wbindgen_export_0: (a: number) => void;
  readonly __wbindgen_export_1: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_2: (a: number, b: number) => number;
  readonly __wbindgen_export_3: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_5: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_6: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_7: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_8: (a: number, b: number, c: number, d: number) => void;
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
