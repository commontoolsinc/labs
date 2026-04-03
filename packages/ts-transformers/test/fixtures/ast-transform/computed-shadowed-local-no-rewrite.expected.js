import * as __cfHelpers from "commonfabric";
// FIXTURE: computed-shadowed-local-no-rewrite
// Verifies: shadowed local helpers named `computed` are not rewritten.
function computed<T>(fn: () => T): T {
    return fn();
}
export default computed(() => 1);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
