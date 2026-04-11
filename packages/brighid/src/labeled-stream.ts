/**
 * LabeledStream - A readable/writable stream for piping labeled data between commands
 *
 * Each chunk carries its own label, allowing fine-grained tracking of
 * data provenance through shell pipes.
 */

import { Label, Labeled, labels } from "./labels.ts";

export interface LabeledChunk {
  data: string;
  label: Label;
}

/**
 * LabeledStream - a stream of labeled chunks
 *
 * Supports:
 * - write(data, label) - append a chunk
 * - read() - consume next chunk (async, waits for data)
 * - readAll() - consume all chunks and join their labels
 * - close() - signal end of stream
 */
export class LabeledStream {
  private buffer: LabeledChunk[] = [];
  private _closed = false;
  private waiters: Array<(chunk: LabeledChunk | null) => void> = [];

  /**
   * Write a chunk to the stream
   */
  write(data: string, label: Label): void {
    if (this._closed) {
      throw new Error("Cannot write to closed stream");
    }
    this.writeLabeled({ data, label });
  }

  /**
   * Write a labeled chunk to the stream
   */
  writeLabeled(chunk: LabeledChunk): void {
    if (this._closed) {
      throw new Error("Cannot write to closed stream");
    }

    this.buffer.push(chunk);

    // Notify any waiting readers
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const nextChunk = this.buffer.shift()!;
      waiter(nextChunk);
    }
  }

  /**
   * Read the next chunk from the stream
   * Returns null when the stream is closed and buffer is empty
   */
  read(): Promise<LabeledChunk | null> {
    // If there's data in the buffer, return it immediately
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!);
    }

    // If stream is closed and buffer is empty, return null (EOF)
    if (this._closed) {
      return Promise.resolve(null);
    }

    // Wait for data to be written or stream to close
    return new Promise<LabeledChunk | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Read all remaining chunks and join their labels
   * Consumes the entire stream until EOF
   */
  async readAll(): Promise<Labeled<string>> {
    const chunks: LabeledChunk[] = [];

    // Drain the stream
    while (true) {
      const chunk = await this.read();
      if (chunk === null) break;
      chunks.push(chunk);
    }

    // Join all data and labels
    if (chunks.length === 0) {
      return {
        value: "",
        label: labels.bottom(),
      };
    }

    const value = chunks.map((c) => c.data).join("");
    const label = labels.joinAll(chunks.map((c) => c.label));

    return { value, label };
  }

  /**
   * Close the stream, signaling no more data will be written
   */
  close(): void {
    if (this._closed) return;

    this._closed = true;

    // Notify all waiting readers that the stream is closed
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }

  /**
   * Check if the stream is closed
   */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Create a stream from a single labeled value
   */
  static from(value: Labeled<string>): LabeledStream {
    const stream = new LabeledStream();
    stream.write(value.value, value.label);
    stream.close();
    return stream;
  }

  /**
   * Create an empty closed stream
   */
  static empty(): LabeledStream {
    const stream = new LabeledStream();
    stream.close();
    return stream;
  }
}
