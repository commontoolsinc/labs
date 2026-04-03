import * as __cfHelpers from "commonfabric";
import { Cell, OpaqueCell, Stream } from "commonfabric";
// FIXTURE: cell-static-factories
// Verifies: static cell factories inject schemas from explicit, inferred, and contextual types
//   Cell.of<string>("hello") → Cell.of<string>("hello", { type: "string" })
//   Cell.of(123) → Cell.of(123, { type: "number" })
//   const cell: Cell<number> = Cell.for("cause") → Cell.for("cause").asSchema({ type: "number" })
//   OpaqueCell.of<boolean>(true) / Stream.of<number>(1) also receive injected schemas
export default function TestCellStaticFactories() {
    const explicitString = Cell.of<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const inferredNumber = Cell.of(123, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const explicitCause = Cell.for<string>("cause").asSchema({
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const contextualCause: Cell<number> = Cell.for("cause").asSchema({
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const opaque = OpaqueCell.of<boolean>(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    const stream = Stream.of<number>(1, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        explicitString,
        inferredNumber,
        explicitCause,
        contextualCause,
        opaque,
        stream,
    };
}
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
