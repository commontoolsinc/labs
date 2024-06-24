import { tags } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { annotation as annotationRecipe } from "../recipes/annotation.js";
const { include } = tags;

export const annotation = ({
  query,
  data,
}: {
  query: signal.Signal<string>;
  data: { [key: string]: signal.Signal<any> };
}) => {
  const annotation = annotationRecipe({ "?": query, ...data });

  // TODO: Double include is necessary because first one doesn't carry bindings
  return include({ content: annotation.UI });
};
