import type { Observation } from "./score.ts";

/**
 * A replayable batch in time order. Observations live in a temporary file;
 * memory holds one run's payload and an offset and timestamp per run.
 */
export class ObservationSpool implements Disposable, Iterable<Observation> {
  readonly #path: string;
  readonly #file: Deno.FsFile;
  readonly #runs: { at: number; offset: number; length: number }[] = [];
  #length = 0;
  #count = 0;
  #latest: { at: number; day: string } | undefined;

  /** Constructs an instance backed by an empty temporary file. */
  constructor() {
    this.#path = Deno.makeTempFileSync({ prefix: "test-selection-" });
    try {
      this.#file = Deno.openSync(this.#path, { read: true, write: true });
    } catch (error) {
      Deno.removeSync(this.#path);
      throw error;
    }
  }

  /** The number of observations appended. */
  get count(): number {
    return this.#count;
  }

  /** The day of the latest run, absent for an empty batch. */
  get newestDay(): string | undefined {
    return this.#latest?.day;
  }

  /** Appends one run. Every observation must have the same start time. */
  add(observations: readonly Observation[]): void {
    const first = observations[0];
    if (first === undefined) return;
    const at = Date.parse(first.startedAt);
    if (
      !Number.isFinite(at) ||
      observations.some((observation) =>
        observation.startedAt !== first.startedAt
      )
    ) {
      throw new Error("An observation run must have one valid start time.");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(observations));
    this.#file.seekSync(this.#length, Deno.SeekMode.Start);
    for (let written = 0; written < bytes.length;) {
      const count = this.#file.writeSync(bytes.subarray(written));
      if (count <= 0) {
        throw new Error("Writing the observation spool made no progress.");
      }
      written += count;
    }
    this.#runs.push({ at, offset: this.#length, length: bytes.length });
    this.#length += bytes.length;
    this.#count += observations.length;
    if (this.#latest === undefined || at > this.#latest.at) {
      this.#latest = { at, day: first.day };
    }
  }

  /** Replays the complete batch, preserving insertion order at equal times. */
  *[Symbol.iterator](): Generator<Observation> {
    this.#runs.sort((a, b) => a.at - b.at);
    for (const run of this.#runs) {
      this.#file.seekSync(run.offset, Deno.SeekMode.Start);
      const bytes = new Uint8Array(run.length);
      for (let read = 0; read < bytes.length;) {
        const count = this.#file.readSync(bytes.subarray(read));
        if (count === null) {
          throw new Error("The observation spool is truncated.");
        }
        if (count <= 0) {
          throw new Error("Reading the observation spool made no progress.");
        }
        read += count;
      }
      const observations = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as Observation[];
      yield* observations;
    }
  }

  /** Closes and removes the temporary file. */
  [Symbol.dispose](): void {
    try {
      this.#file.close();
    } finally {
      Deno.removeSync(this.#path);
    }
  }
}
