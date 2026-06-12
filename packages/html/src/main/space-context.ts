/**
 * The element-level "space" context: the worker reconciler stamps each
 * create-element op with the space of the cell whose render produced it
 * (elided when the parent's matches), and the applicator answers the
 * standard context-request protocol for it here — dependency-free.
 *
 * The KEY is the string "space": @lit/context's createContext returns
 * its key argument verbatim, so consumers built with
 * createContext("space") (e.g. @commonfabric/ui's spaceContext) match
 * this provider by value with no shared import. Nearest provider wins
 * by event propagation, which is exactly right for cross-space
 * transclusion: a transcluded subtree's boundary element answers
 * before any outer piece or view provider.
 */
export const SPACE_CONTEXT_KEY = "space";

type ContextRequestEvent = Event & {
  context: unknown;
  callback: (value: string | undefined, unsubscribe?: () => void) => void;
  subscribe?: boolean;
};

export function provideElementSpace(element: EventTarget, space: string) {
  element.addEventListener("context-request", (event) => {
    const request = event as ContextRequestEvent;
    if (request.context !== SPACE_CONTEXT_KEY) return;
    if (typeof request.callback !== "function") return;
    event.stopPropagation();
    // The value is fixed for the element's lifetime (the reconciler
    // replaces the element when its producing cell changes spaces), so
    // a single callback satisfies both one-shot and subscribe modes.
    request.callback(space, () => {});
  });
}
