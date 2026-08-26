/**
 * Hosts explicit, discoverable capabilities for one sandboxed iframe guest.
 * Only resources named by the embedding host are reachable through the port.
 */

import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";

import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  type BridgeError,
  type BridgeHostMessage,
  type BridgeManifest,
  type BridgeRequest,
  type BridgeResourceDescriptor,
  isBridgeRequest,
} from "./ipc.ts";

/** Behavior advertised for one named bridge resource. */
export type BridgeResourceKind = "cell" | "stream" | "sqlite" | "service";

/** Cancels a live bridge subscription. */
export type BridgeCancel = () => void;

/** Implements one named operation on a bridge resource. */
export type BridgeMethod = (
  input: FabricValue | undefined,
) => FabricValue | undefined | Promise<FabricValue | undefined>;

/** Host implementation and discoverable metadata for one capability. */
export type BridgeResource = {
  kind: BridgeResourceKind;
  schema?: FabricValue;
  description?: string;
  read?: () => FabricValue | undefined | Promise<FabricValue | undefined>;
  write?: (value: FabricValue) => void | Promise<void>;
  subscribe?: (
    listener: (value: FabricValue | undefined) => void,
  ) => BridgeCancel;
  methods?: Record<string, BridgeMethod>;
};

/** Named capabilities granted to one iframe guest. */
export type FabricBridge = {
  resources: Readonly<Record<string, BridgeResource>>;
};

/** Builds an explicit iframe capability grant from named resources. */
export function createFabricBridge(
  resources: Record<string, BridgeResource>,
): FabricBridge {
  return { resources };
}

function descriptor(resource: BridgeResource): BridgeResourceDescriptor {
  const methods: string[] = [];
  if (resource.read) methods.push("read");
  if (resource.write) methods.push("write");
  if (resource.subscribe) methods.push("subscribe");
  methods.push(...Object.keys(resource.methods ?? {}).sort());
  return {
    kind: resource.kind,
    methods,
    ...(resource.schema !== undefined && { schema: resource.schema }),
    ...(resource.description !== undefined && {
      description: resource.description,
    }),
  };
}

function bridgeError(
  code: string,
  message: string,
  resource?: string,
): BridgeError {
  return { code, message, ...(resource !== undefined && { resource }) };
}

function normalizeBridgeError(
  error: unknown,
  resource?: string,
): BridgeError {
  if (
    error && typeof error === "object" && "code" in error &&
    "message" in error && typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    const errorResource = "resource" in error &&
        typeof error.resource === "string"
      ? error.resource
      : resource;
    return bridgeError(error.code, error.message, errorResource);
  }
  return bridgeError(
    "operation-failed",
    error instanceof Error ? error.message : String(error),
    resource,
  );
}

/** Owns one loaded guest's access to one explicitly supplied bridge. */
export class FabricBridgeHost {
  readonly #bridge: FabricBridge;
  readonly #port: MessagePort;
  readonly #subscriptions = new Map<string, BridgeCancel>();
  #connected = true;

  constructor(bridge: FabricBridge, port: MessagePort) {
    this.#bridge = bridge;
    this.#port = port;
    this.#port.onmessage = this.#onMessage;
    this.#port.start();
  }

  /** Cancels subscriptions and closes this guest's port. */
  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    for (const cancel of this.#subscriptions.values()) {
      try {
        cancel();
      } catch {
        // One broken resource must not retain the rest of the guest session.
      }
    }
    this.#subscriptions.clear();
    this.#port.close();
  }

  #post(message: BridgeHostMessage): void {
    if (this.#connected) {
      this.#port.postMessage(realmFromFabricValue(message));
    }
  }

  #manifest(): BridgeManifest {
    return {
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      resources: Object.fromEntries(
        Object.entries(this.#bridge.resources).map(([name, resource]) => [
          name,
          descriptor(resource),
        ]),
      ),
    };
  }

  #onMessage = (event: MessageEvent): void => {
    let decoded: FabricValue;
    try {
      decoded = fabricFromRealmValue(event.data);
    } catch {
      return;
    }
    if (!isBridgeRequest(decoded)) return;
    void this.#handle(decoded);
  };

  async #handle(request: BridgeRequest): Promise<void> {
    if (request.operation === "disconnect") {
      this.disconnect();
      return;
    }
    try {
      const value = await this.#perform(request);
      this.#post({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "response",
        id: request.id,
        ok: true,
        ...(value !== undefined && { value }),
      });
    } catch (error) {
      this.#post({
        protocol: BRIDGE_PROTOCOL,
        version: BRIDGE_VERSION,
        type: "response",
        id: request.id,
        ok: false,
        error: normalizeBridgeError(error, request.resource),
      });
    }
  }

  async #perform(request: BridgeRequest): Promise<FabricValue | undefined> {
    if (request.operation === "describe") return this.#manifest();

    const resource = request.resource !== undefined &&
        Object.hasOwn(this.#bridge.resources, request.resource)
      ? this.#bridge.resources[request.resource]
      : undefined;
    if (!resource || request.resource === undefined) {
      throw bridgeError(
        "resource-not-found",
        `No bridge resource is named \`${request.resource ?? ""}\`.`,
        request.resource,
      );
    }

    switch (request.operation) {
      case "read":
        if (!resource.read) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` is not readable.`,
            request.resource,
          );
        }
        return await resource.read();
      case "write":
        if (!resource.write) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` is not writable.`,
            request.resource,
          );
        }
        await resource.write(request.value as FabricValue);
        return undefined;
      case "call": {
        const method = request.method !== undefined &&
            Object.hasOwn(resource.methods ?? {}, request.method)
          ? resource.methods?.[request.method]
          : undefined;
        if (!method) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` has no method \`${
              request.method ?? ""
            }\`.`,
            request.resource,
          );
        }
        return await method(request.value);
      }
      case "subscribe": {
        if (!resource.subscribe || request.subscription === undefined) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` is not subscribable.`,
            request.resource,
          );
        }
        this.#subscriptions.get(request.subscription)?.();
        const subscription = request.subscription;
        const cancel = resource.subscribe((value) => {
          this.#post({
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            type: "event",
            subscription,
            ...(value !== undefined && { value }),
          });
        });
        this.#subscriptions.set(subscription, cancel);
        return undefined;
      }
      case "unsubscribe":
        if (request.subscription !== undefined) {
          this.#subscriptions.get(request.subscription)?.();
          this.#subscriptions.delete(request.subscription);
        }
        return undefined;
    }
  }
}
