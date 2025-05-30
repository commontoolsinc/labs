import { Cell } from "../cell.ts";
import { getTopFrame } from "@commontools/builder";
import { getCellLinkOrThrow } from "../query-result-proxy.ts";
import { type JSONSchema } from "@commontools/builder";
import { type IRuntime } from "../runtime.ts";

export const createCellFactory = (runtime: IRuntime) => {
  return function createCell<T = any>(
    schema?: JSONSchema,
    name?: string,
    value?: T,
  ): Cell<T> {
    const frame = getTopFrame();
    // TODO(seefeld): This is a rather hacky way to get the context, based on the
    // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
    // abstractions for context here as well.
    const cellLink = frame?.unsafe_binding?.materialize([]);
    if (!frame || !frame.cause || !cellLink) {
      throw new Error(
        "Can't invoke createCell outside of a lifted function or handler",
      );
    }
    const space = getCellLinkOrThrow(cellLink).cell.space;

    const cause = { parent: frame.cause } as Record<string, any>;
    if (name) cause.name = name;
    else cause.number = frame.generatedIdCounter++;

    const cell = runtime.getCell<T>(space, cause, schema);

    if (value !== undefined) cell.set(value);

    return cell;
  };
};
