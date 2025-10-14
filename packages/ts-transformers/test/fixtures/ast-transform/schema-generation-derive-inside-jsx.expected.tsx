import * as __ctHelpers from "commontools";
import { derive } from "commontools";
declare const value: number;
export const result = (<div>
    {derive({
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema, value, (v) => v * 2)}
  </div>);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
