/** Helper functions for `ArrayBuffer`s and the views onto them. */

/**
 * Returns a `Uint8Array` with the same contents as `bytes`, whose underlying
 * buffer is reachable only through the result. This is what a value that
 * promises a byte sequence is immutable needs: `Object.freeze()` does not
 * reach `ArrayBuffer` contents, so sole ownership of the buffer is the
 * defense.
 *
 * `transfer` states that the caller has given up its own use of `bytes`, which
 * permits taking over its buffer rather than copying it. It is a permission and
 * not a promise: what the caller cedes is `bytes`, and detaching reaches the
 * whole buffer behind it. So a `bytes` that covers only part of its buffer is
 * copied even so, since the rest of that buffer may carry unrelated live views
 * -- an allocator handing out windows onto a shared block is a common shape.
 * A source backed by a `SharedArrayBuffer` is likewise copied, that being a
 * buffer which cannot be detached at all.
 *
 * A caller passing `true` must therefore treat `bytes` as consumed either way,
 * since it cannot tell which of the two happened. Passing an already-detached
 * `bytes` throws, as reading it would.
 *
 * @param bytes - The source bytes.
 * @param transfer - Whether the caller cedes `bytes`.
 */
export function toOwnedUint8Array(
  bytes: Uint8Array,
  transfer: boolean,
): Uint8Array {
  const buffer = bytes.buffer;

  if (
    transfer && (buffer instanceof ArrayBuffer) && !buffer.detached &&
    (bytes.byteOffset === 0) && (bytes.byteLength === buffer.byteLength)
  ) {
    return new Uint8Array(buffer.transfer());
  }

  return new Uint8Array(bytes);
}
