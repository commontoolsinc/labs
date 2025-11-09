/// <cts-enable />
import { handler, link } from "commontools";

/**
 * Handler for creating links between charm cells.
 * Used by chatbot.tsx to enable LLM-driven cell linking.
 *
 * Usage:
 *   createLink({
 *     source: "SourceCharm/result/value",
 *     target: "TargetCharm/input/field"
 *   })
 */
export const linkTool = handler<
  { source: string; target: string },
  Record<PropertyKey, never>
>(({ source, target }) => link(source, target));
