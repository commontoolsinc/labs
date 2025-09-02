import { type JSONSchema, type Recipe } from "../builder/types.ts";
import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type AddCancel } from "../cancel.ts";
import type { IRuntime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("[map3]");

/**
 * Implemention of built-in map module. Unlike regular modules, this will be
 * called once at setup and thus sets up its own actions for the scheduler.
 *
 * The goal is to keep the output array current without recomputing too much.
 *
 * Approach:
 * 1. Create a doc to store the result.
 * 2. Create a handler to update the result doc when the input doc changes.
 * 3. Create a handler to update the result doc when the op doc changes.
 * 4. For each value in the input doc, create a handler to update the result
 *    doc when the value changes.
 *
 * TODO: Optimization depends on javascript objects and not lookslike objects.
 * We should make sure updates to arrays don't unnecessarily re-ify objects
 * and/or change the comparision here.
 *
 * @param list - A doc containing an array of values to map over.
 * @param op - A recipe to apply to each value.
 * @returns A doc containing the mapped values.
 */
export function map(
  inputsCell: Cell<{
    list: any[];
    op: Recipe;
  }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: AddCancel,
  cause: any,
  parentCell: Cell<any>,
  runtime: IRuntime, // Runtime will be injected by the registration function
): Action {
  // Tracks up to where in the source array we've handled entries. Right now we
  // start at zero, even though in principle the result doc above could have
  // been pre-initalized from storage, so that we `run` each recipe. Once that
  // is automated on rehyrdation, we can change this to measure the difference
  // between the source list and the result list.
  let initializedUpTo = 0;
  let result: Cell<any[]> | undefined;

  return (tx: IExtendedStorageTransaction) => {
    if (!result) {
      result = runtime.getCell<any[]>(
        parentCell.space,
        {
          map: parentCell.entityId,
          op: inputsCell.getAsQueryResult([], tx)?.op,
          cause,
        },
        undefined,
        tx,
      );
      result.send([]);
      result.setSourceCell(parentCell);
      
      logger.log(() => {
        const resultJson = result!.toJSON();
        const resultEntityId = resultJson.cell ? resultJson.cell['/'] : 'no-cell';
        
        // Get parent entity ID from the map parameter used to create the result cell
        // parentCell.entityId is an IPLD link object like { "/": "baedrei..." }
        const parentEntityIdValue = parentCell.entityId;
        let parentEntityIdStr = 'unknown';
        if (typeof parentEntityIdValue === 'string') {
          parentEntityIdStr = parentEntityIdValue;
        } else if (parentEntityIdValue && typeof parentEntityIdValue === 'object' && '/' in parentEntityIdValue) {
          parentEntityIdStr = (parentEntityIdValue as any)['/'];
        } else if (parentEntityIdValue && typeof parentEntityIdValue === 'object') {
          // Fallback: try to get from cell's JSON representation
          const parentJson = parentCell.toJSON();
          parentEntityIdStr = parentJson.cell ? parentJson.cell['/'] : JSON.stringify(parentEntityIdValue);
        }
        
        // Log cause details
        let causeStr = 'unknown';
        try {
          if (typeof cause === 'string') {
            causeStr = cause;
          } else if (cause && typeof cause === 'object') {
            // Try to stringify key parts of the cause
            causeStr = JSON.stringify(cause).substring(0, 200);
          }
        } catch (e) {
          causeStr = 'error-serializing-cause';
        }
        
        return [`[CT823-MAP-CONTAINER] Created map result container - containerEntityId: ${resultEntityId}, parentEntityId: ${parentEntityIdStr}, parentSpace: ${parentCell.space}, cause: ${causeStr}`];
      });
      sendResult(tx, result);
    }
    const resultWithLog = result.withTx(tx);
    const { list, op } = inputsCell.asSchema(
      {
        type: "object",
        properties: {
          list: { type: "array", items: { asCell: true } },
          op: { asCell: true },
        },
        required: ["list", "op"],
        additionalProperties: false,
      } as const satisfies JSONSchema,
    ).withTx(tx).get();

    // .getRaw() because we want the recipe itself and avoid following the
    // aliases in the recipe
    const opRecipe = op.getRaw() as any;

    // If the result's value is undefined, set it to the empty array.
    if (resultWithLog.get() === undefined) {
      resultWithLog.set([]);
    }
    // If the list is undefined it means the input isn't available yet.
    // Correspondingly, the result should be []. TODO: Maybe it's important to
    // distinguish empty inputs from undefined inputs?
    if (list === undefined) {
      resultWithLog.set([]);
      // Reset progress so that once the list becomes defined again we
      // recompute from the beginning.
      initializedUpTo = 0;
      return;
    }

    if (!Array.isArray(list)) {
      throw new Error("map currently only supports arrays");
    }

    const newArrayValue = resultWithLog.get().slice(0, initializedUpTo);
    // Add values that have been appended
    logger.log(() => [`[CT823-MAP] Processing map: initializedUpTo=${initializedUpTo}, list.length=${list.length}`]);
    while (initializedUpTo < list.length) {
      logger.log(() => [`[CT823-MAP] Creating result cell for index ${initializedUpTo}`]);
      const resultCell = runtime.getCell(
        parentCell.space,
        { result, index: initializedUpTo },
        undefined,
        tx,
      );
      logger.log(() => {
        const cellJson = resultCell.toJSON();
        const entityId = cellJson.cell ? cellJson.cell['/'] : 'no-cell';
        return [`[CT823-MAP] Result cell entity ID for index ${initializedUpTo}: ${entityId}`];
      });
      logger.log(() => [`[CT823-MAP] Running map recipe for index ${initializedUpTo}`]);
      runtime.runner.run(
        tx,
        opRecipe,
        {
          element: inputsCell.key("list").key(initializedUpTo),
          index: initializedUpTo,
          array: inputsCell.key("list"),
        },
        resultCell,
      );
      logger.log(() => {
        const cellJson = resultCell.toJSON();
        const entityId = cellJson.cell ? cellJson.cell['/'] : 'no-cell';
        return [`[CT823-MAP] Recipe run complete for index ${initializedUpTo}, resultCell entityId: ${entityId}`];
      });
      resultCell.getSourceCell()!.setSourceCell(parentCell);
      // Add cancel from runtime's runner
      addCancel(() => runtime.runner.stop(resultCell));

      // Send the result value to the result cell
      logger.log(() => {
        const cellJson = resultCell.toJSON();
        const entityId = cellJson.cell ? cellJson.cell['/'] : 'no-cell';
        
        // Get parent entity ID as a string
        // parentCell.entityId is an IPLD link object like { "/": "baedrei..." }
        const parentEntityIdValue = parentCell.entityId;
        let parentEntityIdStr = 'unknown';
        if (typeof parentEntityIdValue === 'string') {
          parentEntityIdStr = parentEntityIdValue;
        } else if (parentEntityIdValue && typeof parentEntityIdValue === 'object' && '/' in parentEntityIdValue) {
          parentEntityIdStr = (parentEntityIdValue as any)['/'];
        } else if (parentEntityIdValue && typeof parentEntityIdValue === 'object') {
          // Fallback: try to get from cell's JSON representation
          const parentJson = parentCell.toJSON();
          parentEntityIdStr = parentJson.cell ? parentJson.cell['/'] : JSON.stringify(parentEntityIdValue);
        }
        
        // BREAKPOINT: This is where individual VNode cells get their entity IDs
        // resultCell contains the VNode for each mapped element
        
        return [`[CT823-MAP-VNODE] Created result cell for index ${initializedUpTo} - childEntityId: ${entityId}, parentEntityId: ${parentEntityIdStr}, parentSpace: ${parentCell.space}`];
      });
      resultWithLog.key(initializedUpTo).set(resultCell);
      newArrayValue.push(resultCell);

      initializedUpTo++;
    }
    logger.log(() => [`[CT823-MAP] Map complete: processed ${initializedUpTo} elements`]);

    // Shorten the result if the list got shorter
    if (resultWithLog.get().length > list.length) {
      resultWithLog.set(resultWithLog.get().slice(0, list.length));
      initializedUpTo = list.length;
    } else if (resultWithLog.get().length < list.length) {
      resultWithLog.set(newArrayValue);
    }

    // NOTE: We leave prior results in the list for now, so they reuse prior
    // runs when items reappear
    //
    // Remove values that are no longer in the input sourceRefToResult =
    // sourceRefToResult.filter(({ ref }) => seen.find((seenValue) =>
    // isEqualCellReferences(seenValue, ref))
    //);
  };
}
