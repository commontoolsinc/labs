import * as __ctHelpers from "commontools";
// FIXTURE: computed-shadowed-local-no-rewrite
// Verifies: shadowed local helpers named `computed` are not rewritten.
function computed<T>(fn: () => T): T {
    return fn();
}
export default computed(() => 1);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
