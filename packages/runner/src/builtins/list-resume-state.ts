import { isDataUnavailable } from "@commonfabric/data-model/fabric-instances";

/**
 * Whether a resumed list coordinator must preserve its durable result until
 * the input list is confirmed. A prior unavailable marker is durable state in
 * exactly the same way as a non-empty list; treating its links-only length as
 * zero would let the coordinator overwrite it with an eager empty array.
 */
export function shouldAwaitResumedListInput(
  awaitsResumeSync: boolean,
  rawResult: unknown,
  list: unknown,
  priorLength: number,
): boolean {
  if (!awaitsResumeSync) return false;
  if (list !== undefined && (!Array.isArray(list) || list.length > 0)) {
    return false;
  }
  return priorLength > 0 || isDataUnavailable(rawResult);
}
