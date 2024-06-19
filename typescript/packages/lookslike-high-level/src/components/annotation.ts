import { view, tags } from "@commontools/common-ui";
import { signal } from "@commontools/common-frp";
import { annotation as annotationRecipe } from "../recipes/annotation.js";
const { include } = tags;
const { binding } = view;

export const annotation = ({
  query,
  data,
}: {
  query: signal.Signal<string>;
  data: { [key: string]: signal.Signal<any> };
}) => {
  const annotation = annotationRecipe({ "?": query, ...data });

  // TODO: Double include is necessary because first one doesn't carry bindings
  return include({
    content: [include({ content: binding("UI") }), { UI: annotation["UI"] }],
  });
};
