// Keeps the page's live-update stream connected. Runs in the browser: the shell
// injects it into the page and drives it from the same one-second tick that
// paints the freshness indicator.

/** The parts of `EventSource` the reconnection logic reads. */
export interface UpdateStream {
  readonly readyState: number;
  close(): void;
}

export interface LiveUpdateStream {
  /** Records that the server was heard from. Called for every stream event. */
  heard(now: number): void;
  /** Records the browser reporting the connection failed or dropped. */
  lost(): void;
  /**
   * Opens the stream, replaces one that has stopped delivering, and reports
   * whether the page has a stream it is hearing the server on.
   */
  check(now: number): boolean;
}

/**
 * Watches one update stream and replaces it when the server stops arriving.
 *
 * The browser reconnects a stream that ends in a network error and gives up on
 * one whose reconnect is answered with an error page, which is what a proxy in
 * front of a restarting server sends. A connection can also stay open while
 * nothing comes down it, after the machine sleeps or the network moves. This
 * covers all three: any stream the server has not been heard on for
 * `silenceMs` is closed and reopened, and a stream that was working and then
 * closed is reopened at once.
 *
 * A stream that has never been heard on is only ever reopened on the silence
 * interval, so a server that refuses or fails connections costs one request an
 * interval however long it is away. A server that accepts a connection and then
 * drops it arms the prompt reopen again each time, so the page follows a
 * flapping server as fast as it flaps.
 *
 * Reopening the stream and reporting whether the page can hear the server are
 * separate questions with separate answers. Reopening is paced, because each
 * attempt costs a request. Reporting is not: the browser says the moment a
 * connection drops, and `check` passes that on the first time it is asked.
 *
 * `silenceMs` has to be longer than the server's heartbeat period, or a healthy
 * stream is replaced on every tick.
 */
export function liveUpdateStream<S extends UpdateStream>(
  silenceMs: number,
  open: () => S,
): LiveUpdateStream {
  const CLOSED = 2; // EventSource.CLOSED
  let stream: S | null = null;
  let openedAt = 0;
  let heardAt = 0;
  let heardOnThisStream = false;
  // The page arrived over a working connection to the same server, so it starts
  // out as connected as the browser has told it anything.
  let dropped = false;

  const replace = (now: number): S => {
    if (stream) {
      // Standing in a stream the page has heard nothing on leaves it with
      // nothing it is hearing the server on, whatever the stream being
      // replaced had managed. The page it was opened for is the exception:
      // that one arrived over a working connection to the same server.
      stream.close();
      dropped = true;
    }
    stream = open();
    openedAt = now;
    heardOnThisStream = false;
    return stream;
  };

  return {
    heard(now: number): void {
      heardAt = now;
      heardOnThisStream = true;
      dropped = false;
    },
    lost(): void {
      dropped = true;
    },
    check(now: number): boolean {
      let current = stream;
      if (!current) {
        heardAt = now; // the server served this page
        current = replace(now);
      } else if (heardOnThisStream && current.readyState === CLOSED) {
        current = replace(now);
      } else if (now - Math.max(heardAt, openedAt) >= silenceMs) {
        current = replace(now);
      }
      // Every part of this is something the browser has said, not something
      // inferred from how long ago it said it. A dropped connection is reported
      // the moment it drops, and a stream is only heard on again when an event
      // actually arrives. The elapsed interval is the last resort, for a
      // connection that stays open with nothing coming down it, which is the
      // one case the browser reports nothing about at all.
      return !dropped && current.readyState !== CLOSED &&
        now - heardAt < silenceMs;
    },
  };
}
