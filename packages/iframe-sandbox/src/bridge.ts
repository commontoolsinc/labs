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

const CORE_OPERATIONS = new Set(["read", "write", "subscribe"]);

type CoreOperation = "read" | "write" | "subscribe";

function coreOperation<K extends CoreOperation>(
  resource: BridgeResource,
  operation: K,
): BridgeResource[K] | undefined {
  const property = Object.getOwnPropertyDescriptor(resource, operation);
  return property && "value" in property &&
      typeof property.value === "function"
    ? property.value as BridgeResource[K]
    : undefined;
}

function resourceKind(
  name: string,
  resource: BridgeResource,
): BridgeResourceKind {
  const kind = Object.getOwnPropertyDescriptor(resource, "kind");
  if (
    !kind || !("value" in kind) ||
    kind.value !== "cell" && kind.value !== "stream" &&
      kind.value !== "sqlite" && kind.value !== "service"
  ) {
    throw new TypeError(
      `Bridge resource \`${name}\` must declare its own valid kind.`,
    );
  }
  return kind.value;
}

function namedMethodNames(
  name: string,
  resource: BridgeResource,
): string[] {
  const container = Object.getOwnPropertyDescriptor(resource, "methods");
  if (!container) return [];
  if ("value" in container && container.value === undefined) return [];
  if (
    !("value" in container) || container.value === null ||
    typeof container.value !== "object" || Array.isArray(container.value)
  ) {
    throw new TypeError(
      `Bridge resource \`${name}\` methods must be an object.`,
    );
  }
  const methods = container.value as Record<string, unknown>;
  return Object.keys(methods).sort().map((method) => {
    if (CORE_OPERATIONS.has(method)) {
      throw new TypeError(
        `Bridge resource \`${name}\` method \`${method}\` collides with a core operation.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(methods, method);
    if (!descriptor || typeof descriptor.value !== "function") {
      throw new TypeError(
        `Bridge resource \`${name}\` method \`${method}\` must be a function.`,
      );
    }
    return method;
  });
}

function namedMethod(
  resource: BridgeResource,
  method: string | undefined,
): BridgeMethod | undefined {
  if (method === undefined || CORE_OPERATIONS.has(method)) return undefined;
  const container = Object.getOwnPropertyDescriptor(resource, "methods");
  if (
    !container || !("value" in container) || container.value === null ||
    typeof container.value !== "object" || Array.isArray(container.value)
  ) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(container.value, method);
  return descriptor?.enumerable && typeof descriptor.value === "function"
    ? descriptor.value as BridgeMethod
    : undefined;
}

function descriptor(
  name: string,
  resource: BridgeResource,
): BridgeResourceDescriptor {
  const kind = resourceKind(name, resource);
  const methods: string[] = [];
  if (coreOperation(resource, "read")) {
    methods.push("read");
  }
  if (coreOperation(resource, "write")) {
    methods.push("write");
  }
  if (coreOperation(resource, "subscribe")) {
    methods.push("subscribe");
  }
  methods.push(...namedMethodNames(name, resource));
  const schema = Object.getOwnPropertyDescriptor(resource, "schema");
  const description = Object.getOwnPropertyDescriptor(resource, "description");
  return {
    name,
    kind,
    methods,
    ...(schema && "value" in schema && schema.value !== undefined && {
      schema: schema.value,
    }),
    ...(description && "value" in description &&
      description.value !== undefined && {
      description: description.value,
    }),
  };
}

function discoverResource(
  resources: FabricBridge["resources"],
  name: string,
): BridgeResource | undefined {
  const property = Object.getOwnPropertyDescriptor(resources, name);
  if (!property?.enumerable) return undefined;
  if (!("value" in property)) {
    throw new TypeError(
      `Bridge resource \`${name}\` must be an own data property.`,
    );
  }
  if (
    property.value === null || typeof property.value !== "object" ||
    Array.isArray(property.value)
  ) {
    throw new TypeError(`Bridge resource \`${name}\` must be an object.`);
  }
  const resource = property.value as BridgeResource;
  resourceKind(name, resource);
  return resource;
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
  #operationTail: Promise<void> | undefined;
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
      resources: Object.keys(this.#bridge.resources).map(
        (name) =>
          descriptor(
            name,
            discoverResource(this.#bridge.resources, name)!,
          ),
      ),
    };
  }

  #onMessage = (event: MessageEvent): void => {
    if (!this.#connected) return;
    let decoded: FabricValue;
    try {
      decoded = fabricFromRealmValue(event.data);
    } catch {
      return;
    }
    if (!isBridgeRequest(decoded)) return;
    if (decoded.operation === "disconnect") {
      this.disconnect();
      return;
    }
    const handling = this.#operationTail
      ? this.#operationTail.then(() => {
        if (!this.#connected) return undefined;
        return this.#handle(decoded);
      })
      : this.#handle(decoded);
    const tail = handling.catch(() => {});
    this.#operationTail = tail;
    void tail.then(() => {
      if (this.#operationTail === tail) this.#operationTail = undefined;
    });
  };

  async #handle(request: BridgeRequest): Promise<void> {
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
    const operation = request.operation;
    if (operation === "describe") return this.#manifest();

    const resource = request.resource !== undefined
      ? discoverResource(this.#bridge.resources, request.resource)
      : undefined;
    if (!resource || request.resource === undefined) {
      throw bridgeError(
        "resource-not-found",
        `No bridge resource is named \`${request.resource ?? ""}\`.`,
        request.resource,
      );
    }

    switch (operation) {
      case "read": {
        const read = coreOperation(resource, "read");
        if (!read) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` is not readable.`,
            request.resource,
          );
        }
        return await read.call(resource);
      }
      case "write": {
        const write = coreOperation(resource, "write");
        if (!write) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` is not writable.`,
            request.resource,
          );
        }
        await write.call(resource, request.value as FabricValue);
        return undefined;
      }
      case "call": {
        const method = namedMethod(resource, request.method);
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
        const subscribe = coreOperation(resource, "subscribe");
        if (
          !subscribe || request.subscription === undefined
        ) {
          throw bridgeError(
            "method-not-supported",
            `Resource \`${request.resource}\` is not subscribable.`,
            request.resource,
          );
        }
        this.#subscriptions.get(request.subscription)?.();
        const subscription = request.subscription;
        const cancel = subscribe.call(resource, (value) => {
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
