import { tags } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { annotation as annotationRecipe } from "../recipes/annotation.js";
const { include } = tags;

export const annotation = ({
  query,
  target,
  data,
}: {
  query: signal.Signal<string> | string;
  target: number;
  data: { [key: string]: signal.Signal<any> };
}) => {
  const annotation = annotationRecipe({ "?": query, ".": target, ...data });

  // TODO: Double include is necessary because first one doesn't carry bindings
  return include({ content: annotation.UI });
};
