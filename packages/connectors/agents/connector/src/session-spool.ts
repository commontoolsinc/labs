import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { stableFabricValue } from "./stable-fabric-value.ts";
import type { NativeSessionSnapshot } from "./types.ts";

/**
 * Stores collected snapshots in a private temporary directory. Iteration reads
 * one snapshot at a time. Disposal removes the directory and its contents.
 */
export class SessionSpool
  implements AsyncIterable<NativeSessionSnapshot>, AsyncDisposable {
  readonly #directory: string;
  readonly #codec = newDefaultJsonCodecEngine();
  #length = 0;

  /** Constructs an instance backed by `directory`. */
  private constructor(directory: string) {
    this.#directory = directory;
  }

  /** Number of snapshots successfully written. */
  get length(): number {
    return this.#length;
  }

  /** Writes an immutable copy of `snapshot` before accepting another. */
  async append(snapshot: NativeSessionSnapshot): Promise<void> {
    await Deno.writeTextFile(
      `${this.#directory}/${this.#length}.json`,
      this.#codec.encode(stableFabricValue(snapshot)),
      { createNew: true, mode: 0o600 },
    );
    this.#length++;
  }

  /** Reads snapshots in collection order, with no read ahead. */
  async *[Symbol.asyncIterator](): AsyncGenerator<NativeSessionSnapshot> {
    for (let index = 0; index < this.#length; index++) {
      yield this.#codec.decode(
        await Deno.readTextFile(`${this.#directory}/${index}.json`),
      ) as unknown as NativeSessionSnapshot;
    }
  }

  /** Removes every snapshot, including an incomplete write. */
  async [Symbol.asyncDispose](): Promise<void> {
    await Deno.remove(this.#directory, { recursive: true });
  }

  /** Opens an empty spool in a newly created private temporary directory. */
  static async create(): Promise<SessionSpool> {
    return new SessionSpool(await Deno.makeTempDir({ prefix: "agents-sync-" }));
  }
}
