/**
 * The one connection a shuttle process holds: a `PiecesController` opened
 * once and served to every read and write for the rest of the run. Who holds
 * the controller, for how long, and who closes it are all decisions a
 * long-lived process has to make, and this module is where they are made.
 *
 * The connect sequence belongs to `loadPieces` (`@commonfabric/cli/lib/piece`),
 * which this module calls. What it adds is a memo, and the memo covers the
 * connection that never opened: a rejected construction is not held, so a
 * later ask opens again. A connection that opens and then drops is outside
 * that entirely — nothing here observes a drop, retries one, or reports one.
 */

import { loadPieces, type SpaceConfig } from "@commonfabric/cli/lib/piece";
import type { PiecesController } from "@commonfabric/piece/ops";

/**
 * The connection half of the ambient record: what one shuttle process
 * connects as, fixed for its whole run.
 */
export interface ConnectionRecord {
  /** The deployment to connect to. */
  readonly apiUrl: string;

  /** The space to open, as a `did:key:` DID or as a space name. */
  readonly space: string;

  /** The identity to act as, as the path to its PKCS#8 key file. */
  readonly identity: string;
}

/** Opens a connection over `config` and returns the controller on it. */
export type ConnectionOpener = (
  config: SpaceConfig,
) => Promise<PiecesController>;

/**
 * Where a {@link HeldConnection} gets its controller, and with it who closes
 * it: a connection opened here is closed here, and one opened elsewhere is
 * closed by whoever opened it. Ownership is a property of the source, so it
 * holds whatever opener sits under either arm.
 */
export type ConnectionSource =
  /** Opened here, from `record`, and closed here. */
  | {
    /** Names this arm of {@link ConnectionSource}. */
    readonly kind: "owned";

    /** What to connect as. */
    readonly record: ConnectionRecord;

    /** What opens it; `loadPieces` where the source names none. */
    readonly open?: ConnectionOpener;
  }
  /** Already open, and closed by whoever opened it. */
  | {
    /** Names this arm of {@link ConnectionSource}. */
    readonly kind: "borrowed";

    /** The controller to serve. */
    readonly pieces: PiecesController;
  };

/**
 * Helper for {@link HeldConnection}, which returns the {@link SpaceConfig}
 * `record` denotes: the record's three dimensions, and nothing else the
 * config admits.
 */
function spaceConfigFor(record: ConnectionRecord): SpaceConfig {
  return {
    apiUrl: record.apiUrl,
    space: record.space,
    identity: record.identity,
  };
}

/**
 * The holder of a shuttle process's connection. It opens one on the first
 * ask, hands that same one to every ask after, and on disposal closes
 * whatever it opened.
 *
 * Per instance rather than per process, so that more than one connection
 * stays reachable.
 */
export class HeldConnection implements AsyncDisposable {
  #open: () => Promise<PiecesController>;
  #owned: boolean;
  #pieces: Promise<PiecesController> | undefined;
  #disposed = false;

  /**
   * Constructs an instance serving the connection `source` names. An owned
   * source is opened on the first ask; a borrowed one is open already.
   */
  constructor(source: ConnectionSource) {
    if (source.kind === "borrowed") {
      this.#open = () => Promise.resolve(source.pieces);
      this.#owned = false;
    } else {
      const open = source.open ?? loadPieces;
      const config = spaceConfigFor(source.record);
      this.#open = () => open(config);
      this.#owned = true;
    }
  }

  /**
   * The connection, opened on the first ask and shared by every ask after.
   * An ask made while a construction is in flight joins that construction
   * rather than starting a second one.
   *
   * A rejected construction is not held: the rejection reaches every caller
   * awaiting that attempt, and the next ask opens again rather than replaying
   * a terminal failure for the rest of the run. That covers the connection
   * that never opened, which is the whole of what it covers.
   *
   * Throws once this instance is disposed: a disposed holder serves nothing,
   * whether or not it closed anything.
   */
  pieces(): Promise<PiecesController> {
    if (this.#disposed) {
      throw new Error("This connection is disposed.");
    }
    if (this.#pieces === undefined) {
      const attempt: Promise<PiecesController> = Promise.resolve()
        .then(this.#open)
        .catch((error) => {
          // Only while this attempt is still the held one, so unholding a
          // failure can never take a later, live connection with it. Nothing
          // reaches the other branch as things stand: an ask starts an
          // attempt only where nothing is held, and only a failure unholds.
          if (this.#pieces === attempt) this.#pieces = undefined;
          throw error;
        });
      this.#pieces = attempt;
    }
    return this.#pieces;
  }

  /**
   * Closes the connection this instance opened, and refuses to serve one
   * afterwards. Closing again does nothing.
   *
   * A construction still in flight is awaited and its connection closed, so
   * that a disposal crossing a connect strands nothing; the ask that started
   * it still resolves with that connection. `loadPieces` takes no signal to
   * stop on, so what it opens exists whether or not anyone is still waiting
   * for it, and closing it is the only thing that can be done about it.
   *
   * A connection this instance was handed is left open: it is the caller's to
   * close, and closing it would take down a socket still in use. Where no ask
   * opened one there is nothing to close, and a construction that rejected
   * handed this instance no controller either, so its rejection is neither
   * closed nor re-raised here.
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const held = this.#pieces;
    if (!this.#owned || held === undefined) return;
    const pieces = await held.catch(() => undefined);
    await pieces?.dispose();
  }

  /** @inheritDoc */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
