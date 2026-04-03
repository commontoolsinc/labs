import { defer, Deferred } from "@commontools/utils/defer";
import { sleep } from "@commontools/utils/sleep";

export class HealthCheckTimeout extends Error {
  override name = "HealthCheckTimeout";
}

export class HealthCheckAbort extends Error {
  override name = "HealthCheckAbort";
}

export class HealthCheck {
  readonly nonce: string;
  private deferred: Deferred<void, Error>;
  private _result: Promise<void>;

  // Create a new HealthCheck object to compare
  // to a future `GuestMessageType.Pong` message.
  constructor(timeout: number) {
    this.deferred = defer();
    this.nonce = globalThis.crypto.randomUUID();

    this._result = Promise.race([
      this.deferred.promise,
      sleep(timeout).then(() => {
        throw new HealthCheckTimeout();
      }),
    ]);
  }

  abort() {
    this.deferred.reject(new HealthCheckAbort());
  }

  result(): Promise<void> {
    return this._result;
  }

  tryFulfill(nonce: string) {
    if (this.nonce === nonce) {
      this.deferred.resolve();
    }
  }
}
