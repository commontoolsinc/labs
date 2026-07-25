import {
  type Browser as AstralBrowser,
  ElementHandle as AstralElementHandle,
  type Page as AstralPage,
  type WaitForSelectorOptions,
} from "@astral/astral";

export type QueryStrategy = "native" | "pierce";

export type SelectorOptions = {
  strategy?: QueryStrategy;
};

export type ElementHandle = AstralElementHandle & {
  $(
    selector: string,
    options?: SelectorOptions,
  ): Promise<ElementHandle | null>;
  $$(selector: string, options?: SelectorOptions): Promise<ElementHandle[]>;
  waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions & SelectorOptions,
  ): Promise<ElementHandle>;
};

export interface InteractionObserver {
  beforeClick?(
    element: ElementHandle,
    point: { x: number; y: number },
  ): Promise<void> | void;
  afterClick?(
    element: ElementHandle,
    point: { x: number; y: number },
    error?: unknown,
  ): Promise<void> | void;
  beforeType?(element: ElementHandle, text: string): Promise<void> | void;
  afterType?(
    element: ElementHandle,
    text: string,
    error?: unknown,
  ): Promise<void> | void;
}

export interface ScreencastFrame {
  data: string;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
  sessionId: number;
}

export async function closeAstralBrowser(
  browser: Pick<AstralBrowser, "close">,
): Promise<void> {
  try {
    await browser.close();
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "Child process has already terminated"
    ) {
      return;
    }
    throw error;
  }
}

type CelestialBindings = ReturnType<
  AstralPage["unsafelyGetCelestialBindings"]
>;

function runProtocolCommand<T>(
  bindings: CelestialBindings,
  command: () => Promise<T>,
): Promise<T> {
  const socket = bindings.ws;
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Astral page connection closed"));
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("close", connectionClosed);
      socket.removeEventListener("error", connectionClosed);
    };
    const connectionClosed = () => {
      cleanup();
      reject(new Error("Astral page connection closed"));
    };
    const commandResolved = (value: T) => {
      cleanup();
      resolve(value);
    };
    const commandRejected = (error: unknown) => {
      cleanup();
      reject(error);
    };

    socket.addEventListener("close", connectionClosed, { once: true });
    socket.addEventListener("error", connectionClosed, { once: true });
    if (socket.readyState !== WebSocket.OPEN) {
      connectionClosed();
      return;
    }
    try {
      command().then(commandResolved, commandRejected);
    } catch (error) {
      commandRejected(error);
    }
  });
}

async function runProtocolCleanup(
  bindings: CelestialBindings,
  command: () => Promise<unknown>,
): Promise<void> {
  if (bindings.ws.readyState !== WebSocket.OPEN) return;
  try {
    await runProtocolCommand(bindings, command);
  } catch (error) {
    if (bindings.ws.readyState === WebSocket.OPEN) throw error;
  }
}

let objectGroupSequence = 0;

function nextObjectGroup(): string {
  objectGroupSequence++;
  return `common-tools-pierce-${objectGroupSequence}`;
}

function exceptionMessage(
  exception: {
    text: string;
    exception?: { description?: string };
  },
): string {
  return exception.exception?.description ?? exception.text;
}

type RemoteRoot = {
  objectId: string;
  cleanup(): Promise<void>;
};

async function remoteRoot(
  bindings: CelestialBindings,
  objectGroup: string,
  root?: AstralElementHandle,
): Promise<RemoteRoot> {
  if (root) {
    const rootKey = `__common_tools_pierce_root_${objectGroup}`;
    await runProtocolCommand(
      bindings,
      () =>
        root.evaluate((element, key) => {
          Object.defineProperty(globalThis, key, {
            configurable: true,
            value: element,
          });
        }, { args: [rootKey] }),
    );
    const cleanup = async () => {
      await runProtocolCleanup(
        bindings,
        () =>
          bindings.Runtime.evaluate({
            expression: `delete globalThis[${JSON.stringify(rootKey)}]`,
            returnByValue: true,
          }),
      );
    };
    try {
      const result = await runProtocolCommand(
        bindings,
        () =>
          bindings.Runtime.evaluate({
            expression: `globalThis[${JSON.stringify(rootKey)}]`,
            objectGroup,
            returnByValue: false,
          }),
      );
      if (result.exceptionDetails) {
        throw new Error(exceptionMessage(result.exceptionDetails));
      }
      const objectId = result.result.objectId;
      if (!objectId) {
        throw new Error("Astral did not return a remote element object");
      }
      return {
        objectId,
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  const { root: documentRoot } = await runProtocolCommand(
    bindings,
    () => bindings.DOM.getDocument({ depth: 0 }),
  );
  const { object } = await runProtocolCommand(
    bindings,
    () =>
      bindings.DOM.resolveNode({
        nodeId: documentRoot.nodeId,
        objectGroup,
      }),
  );
  if (!object.objectId) {
    throw new Error("Astral did not return a remote document object");
  }
  return {
    objectId: object.objectId,
    cleanup: () => Promise.resolve(),
  };
}

async function nodeIdsFromArray(
  bindings: CelestialBindings,
  objectId: string,
): Promise<number[]> {
  const properties = await runProtocolCommand(
    bindings,
    () =>
      bindings.Runtime.getProperties({
        objectId,
        ownProperties: true,
      }),
  );
  if (properties.exceptionDetails) {
    throw new Error(exceptionMessage(properties.exceptionDetails));
  }

  const indexedProperties = properties.result
    .filter((property) => /^\d+$/.test(property.name))
    .sort((left, right) => Number(left.name) - Number(right.name));

  return await Promise.all(indexedProperties.map(async (property) => {
    const elementObjectId = property.value?.objectId;
    if (!elementObjectId) {
      throw new Error("Shadow query returned a non-element value");
    }
    const { nodeId } = await runProtocolCommand(
      bindings,
      () =>
        bindings.DOM.requestNode({
          objectId: elementObjectId,
        }),
    );
    return nodeId;
  }));
}

export async function queryPierce(
  page: AstralPage,
  selector: string,
  root?: AstralElementHandle,
): Promise<ElementHandle | null> {
  const elements = await queryAllPierce(page, selector, true, root);
  return elements[0] ?? null;
}

export async function queryAllPierce(
  page: AstralPage,
  selector: string,
  firstOnly = false,
  root?: AstralElementHandle,
): Promise<ElementHandle[]> {
  const bindings = page.unsafelyGetCelestialBindings();
  const objectGroup = nextObjectGroup();
  let cleanupRoot = () => Promise.resolve();
  try {
    const remote = await remoteRoot(bindings, objectGroup, root);
    cleanupRoot = remote.cleanup;
    const queryResult = await runProtocolCommand(
      bindings,
      () =>
        bindings.Runtime.callFunctionOn({
          functionDeclaration: contentPierceQuerySelector.toString(),
          objectId: remote.objectId,
          arguments: [
            { value: selector },
            { value: firstOnly },
          ],
          objectGroup,
          returnByValue: false,
        }),
    );
    if (queryResult.exceptionDetails) {
      throw new Error(exceptionMessage(queryResult.exceptionDetails));
    }
    const resultObjectId = queryResult.result.objectId;
    if (!resultObjectId) return [];

    const nodeIds = await nodeIdsFromArray(bindings, resultObjectId);
    return nodeIds.map((nodeId) =>
      new AstralElementHandle(nodeId, bindings, page) as ElementHandle
    );
  } finally {
    try {
      await cleanupRoot();
    } finally {
      await runProtocolCleanup(
        bindings,
        () => bindings.Runtime.releaseObjectGroup({ objectGroup }),
      );
    }
  }
}

export async function waitForPierceSelector(
  page: AstralPage,
  selector: string,
  root?: AstralElementHandle,
): Promise<ElementHandle> {
  const bindings = page.unsafelyGetCelestialBindings();
  const objectGroup = nextObjectGroup();
  const shadowRootEvent = `${objectGroup}-shadow-root`;
  let cleanupRoot = () => Promise.resolve();
  let rejectInvalidation: (error: unknown) => void = () => {};
  const invalidationFailed = new Promise<never>((_resolve, reject) => {
    rejectInvalidation = reject;
  });
  const shadowRootPushed = () => {
    void runProtocolCommand(
      bindings,
      () =>
        bindings.Runtime.evaluate({
          expression: `document.dispatchEvent(new Event(${
            JSON.stringify(shadowRootEvent)
          }))`,
          returnByValue: true,
        }),
    ).catch(rejectInvalidation);
  };
  try {
    const remote = await remoteRoot(bindings, objectGroup, root);
    cleanupRoot = remote.cleanup;
    bindings.addEventListener("DOM.shadowRootPushed", shadowRootPushed);
    const queryResult = await Promise.race([
      runProtocolCommand(
        bindings,
        () =>
          bindings.Runtime.callFunctionOn({
            functionDeclaration: contentWaitForPierceSelector.toString(),
            objectId: remote.objectId,
            arguments: [
              { value: selector },
              { value: shadowRootEvent },
            ],
            awaitPromise: true,
            objectGroup,
            returnByValue: false,
          }),
      ),
      invalidationFailed,
    ]);
    if (queryResult.exceptionDetails) {
      throw new Error(exceptionMessage(queryResult.exceptionDetails));
    }
    const resultObjectId = queryResult.result.objectId;
    if (!resultObjectId) {
      throw new Error("Shadow query did not return an element");
    }
    const { nodeId } = await runProtocolCommand(
      bindings,
      () =>
        bindings.DOM.requestNode({
          objectId: resultObjectId,
        }),
    );
    return new AstralElementHandle(nodeId, bindings, page) as ElementHandle;
  } finally {
    bindings.removeEventListener("DOM.shadowRootPushed", shadowRootPushed);
    try {
      await cleanupRoot();
    } finally {
      await runProtocolCleanup(
        bindings,
        () => bindings.Runtime.releaseObjectGroup({ objectGroup }),
      );
    }
  }
}

function contentPierceQuerySelector(
  this: Document | Element,
  selector: string,
  firstOnly: boolean,
): Element[] {
  const matches: Element[] = [];

  const visit = (root: Document | Element | ShadowRoot): boolean => {
    for (const element of root.querySelectorAll("*")) {
      const shadowRoot = element.shadowRoot;
      if (!shadowRoot) continue;

      for (const match of shadowRoot.querySelectorAll(selector)) {
        matches.push(match);
        if (firstOnly) return true;
      }
      if (visit(shadowRoot) && firstOnly) return true;
    }
    return false;
  };

  visit(this);
  return matches;
}

function contentWaitForPierceSelector(
  this: Document | Element,
  selector: string,
  shadowRootEvent: string,
): Promise<Element> {
  type StatePropertyPatch = {
    prototype: object;
    name: string;
    descriptor: PropertyDescriptor;
    patchedSetter: (this: unknown, value: unknown) => void;
  };
  type StateMethodPatch = {
    prototype: object;
    name: string;
    originalMethod: (...args: unknown[]) => unknown;
    patchedMethod: (this: unknown, ...args: unknown[]) => unknown;
  };
  type SelectorWaitState = {
    checks: Set<() => void>;
    stateMethodPatches: StateMethodPatch[];
    statePropertyPatches: StatePropertyPatch[];
  };

  const stateKey = Symbol.for("common-tools.astral.selector-waits");
  const stateOwner = globalThis as typeof globalThis & {
    [stateKey]?: SelectorWaitState;
  };

  return new Promise<Element>((resolve, reject) => {
    const observers = new Map<
      Document | Element | ShadowRoot,
      MutationObserver
    >();
    const navigationTarget = (globalThis as typeof globalThis & {
      navigation?: EventTarget;
    }).navigation;
    let finished = false;

    const findMatch = (): Element | undefined => {
      const visit = (
        root: Document | Element | ShadowRoot,
      ): Element | undefined => {
        for (const element of root.querySelectorAll("*")) {
          const shadowRoot = element.shadowRoot;
          if (!shadowRoot) continue;
          const match = shadowRoot.querySelector(selector);
          if (match) return match;
          const nestedMatch = visit(shadowRoot);
          if (nestedMatch) return nestedMatch;
        }
      };
      return visit(this);
    };

    let state = stateOwner[stateKey];
    if (!state) {
      const checks = new Set<() => void>();
      const stateMethodPatches: StateMethodPatch[] = [];
      const statePropertyPatches: StatePropertyPatch[] = [];
      const patchStateProperty = (prototype: object, name: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const originalSetter = descriptor?.set;
        if (!descriptor?.configurable || !originalSetter) return;
        const patchedSetter = function (
          this: unknown,
          value: unknown,
        ): void {
          originalSetter.call(this, value);
          for (const check of checks) check();
        };
        Object.defineProperty(prototype, name, {
          ...descriptor,
          set: patchedSetter,
        });
        statePropertyPatches.push({
          prototype,
          name,
          descriptor,
          patchedSetter,
        });
      };
      const patchStateMethod = (prototype: object, name: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const originalMethod = descriptor?.value;
        if (
          !descriptor ||
          typeof originalMethod !== "function" ||
          (!descriptor.configurable && !descriptor.writable)
        ) {
          return;
        }
        const patchedMethod = function (
          this: unknown,
          ...args: unknown[]
        ): unknown {
          const result = Reflect.apply(originalMethod, this, args);
          for (const check of checks) check();
          return result;
        };
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value: patchedMethod,
        });
        stateMethodPatches.push({
          prototype,
          name,
          originalMethod,
          patchedMethod,
        });
      };
      for (
        const [prototype, names] of [
          [Document.prototype, ["designMode"]],
          [
            HTMLInputElement.prototype,
            [
              "checked",
              "files",
              "indeterminate",
              "value",
              "valueAsDate",
              "valueAsNumber",
            ],
          ],
          [HTMLOptionElement.prototype, ["selected"]],
          [HTMLSelectElement.prototype, ["selectedIndex", "value"]],
          [HTMLTextAreaElement.prototype, ["value"]],
        ] as const
      ) {
        for (const name of names) patchStateProperty(prototype, name);
      }
      for (
        const [prototype, names] of [
          [HTMLButtonElement.prototype, ["setCustomValidity"]],
          [HTMLFieldSetElement.prototype, ["setCustomValidity"]],
          [
            HTMLInputElement.prototype,
            [
              "setCustomValidity",
              "setRangeText",
              "showPicker",
              "stepDown",
              "stepUp",
            ],
          ],
          [HTMLObjectElement.prototype, ["setCustomValidity"]],
          [HTMLOutputElement.prototype, ["setCustomValidity"]],
          [HTMLTextAreaElement.prototype, [
            "setCustomValidity",
            "setRangeText",
          ]],
          [HTMLSelectElement.prototype, ["setCustomValidity", "showPicker"]],
          [HTMLFormElement.prototype, ["reset"]],
          [ElementInternals.prototype, ["setValidity"]],
          [
            CustomElementRegistry.prototype,
            ["define", "initialize", "upgrade"],
          ],
          [CustomStateSet.prototype, ["add", "clear", "delete"]],
          [History.prototype, ["pushState", "replaceState"]],
        ] as const
      ) {
        for (const name of names) patchStateMethod(prototype, name);
      }
      state = {
        checks,
        stateMethodPatches,
        statePropertyPatches,
      };
      stateOwner[stateKey] = state;
    } else {
      const retainedState = state;
      for (const patch of retainedState.statePropertyPatches) {
        const descriptor = Object.getOwnPropertyDescriptor(
          patch.prototype,
          patch.name,
        );
        const originalSetter = descriptor?.set;
        if (
          descriptor?.configurable &&
          originalSetter &&
          originalSetter !== patch.patchedSetter
        ) {
          const patchedSetter = function (
            this: unknown,
            value: unknown,
          ): void {
            originalSetter.call(this, value);
            for (const check of retainedState.checks) check();
          };
          Object.defineProperty(patch.prototype, patch.name, {
            ...descriptor,
            set: patchedSetter,
          });
          patch.descriptor = descriptor;
          patch.patchedSetter = patchedSetter;
        }
      }
      for (const patch of retainedState.stateMethodPatches) {
        const descriptor = Object.getOwnPropertyDescriptor(
          patch.prototype,
          patch.name,
        );
        const originalMethod = descriptor?.value;
        if (
          descriptor &&
          typeof originalMethod === "function" &&
          originalMethod !== patch.patchedMethod &&
          (descriptor.configurable || descriptor.writable)
        ) {
          const patchedMethod = function (
            this: unknown,
            ...args: unknown[]
          ): unknown {
            const result = Reflect.apply(originalMethod, this, args);
            for (const check of retainedState.checks) check();
            return result;
          };
          Object.defineProperty(patch.prototype, patch.name, {
            ...descriptor,
            value: patchedMethod,
          });
          patch.originalMethod = originalMethod;
          patch.patchedMethod = patchedMethod;
        }
      }
    }

    const cleanup = () => {
      for (const [root, observer] of observers) {
        observer.disconnect();
        for (const eventType of selectorStateEvents) {
          root.removeEventListener(eventType, check, true);
        }
        for (const eventType of postStateEvents) {
          root.removeEventListener(eventType, postStateChange, true);
        }
      }
      observers.clear();
      document.removeEventListener("fullscreenchange", check, true);
      globalThis.removeEventListener("hashchange", check);
      globalThis.removeEventListener("popstate", check);
      navigationTarget?.removeEventListener("currententrychange", check);
      document.removeEventListener(shadowRootEvent, protocolShadowRootPushed);
      state.checks.delete(check);
      if (state.checks.size === 0) {
        const retainState = state.statePropertyPatches.some((patch) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            patch.prototype,
            patch.name,
          );
          return descriptor?.set === patch.patchedSetter &&
            !descriptor.configurable;
        }) || state.stateMethodPatches.some((patch) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            patch.prototype,
            patch.name,
          );
          return descriptor?.value === patch.patchedMethod &&
            !descriptor.configurable && !descriptor.writable;
        });
        if (!retainState) {
          for (const patch of state.statePropertyPatches) {
            const descriptor = Object.getOwnPropertyDescriptor(
              patch.prototype,
              patch.name,
            );
            if (
              descriptor?.set === patch.patchedSetter &&
              descriptor.configurable
            ) {
              Object.defineProperty(
                patch.prototype,
                patch.name,
                { ...descriptor, set: patch.descriptor.set },
              );
            }
          }
          for (const patch of state.stateMethodPatches) {
            const descriptor = Object.getOwnPropertyDescriptor(
              patch.prototype,
              patch.name,
            );
            if (
              descriptor?.value === patch.patchedMethod &&
              (descriptor.configurable || descriptor.writable)
            ) {
              Object.defineProperty(
                patch.prototype,
                patch.name,
                { ...descriptor, value: patch.originalMethod },
              );
            }
          }
          delete stateOwner[stateKey];
        }
      }
    };

    const finish = (element: Element) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(element);
    };

    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    };

    const check = () => {
      try {
        const match = findMatch();
        if (match) finish(match);
      } catch (error) {
        fail(error);
      }
    };

    const observe = (root: Document | Element | ShadowRoot) => {
      if (observers.has(root)) return;
      const observer = new MutationObserver(() => {
        discover(root);
        check();
      });
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
      for (const eventType of selectorStateEvents) {
        root.addEventListener(eventType, check, true);
      }
      for (const eventType of postStateEvents) {
        root.addEventListener(eventType, postStateChange, true);
      }
      observers.set(root, observer);
    };

    const discover = (root: Document | Element | ShadowRoot) => {
      for (const element of root.querySelectorAll("*")) {
        const shadowRoot = element.shadowRoot;
        if (!shadowRoot) continue;
        observe(shadowRoot);
        discover(shadowRoot);
      }
    };

    const protocolShadowRootPushed = () => {
      discover(this);
      check();
    };

    const postStateChange = () => {
      queueMicrotask(check);
    };

    const selectorStateEvents = [
      "canplay",
      "canplaythrough",
      "change",
      "emptied",
      "ended",
      "enterpictureinpicture",
      "focusin",
      "focusout",
      "input",
      "interest",
      "invalid",
      "leavepictureinpicture",
      "loadeddata",
      "loseinterest",
      "pause",
      "play",
      "playing",
      "pointerdown",
      "pointerout",
      "pointerover",
      "pointerup",
      "progress",
      "seeked",
      "seeking",
      "stalled",
      "submit",
      "suspend",
      "timeupdate",
      "toggle",
      "volumechange",
      "waiting",
    ];
    const postStateEvents = ["click", "keydown", "keyup", "reset"];

    state.checks.add(check);
    document.addEventListener("fullscreenchange", check, true);
    globalThis.addEventListener("hashchange", check);
    globalThis.addEventListener("popstate", check);
    navigationTarget?.addEventListener("currententrychange", check);
    document.addEventListener(shadowRootEvent, protocolShadowRootPushed);
    observe(this);
    discover(this);
    check();
  });
}
