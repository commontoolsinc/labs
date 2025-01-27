import { h } from "@commontools/html";
import { recipe, UI, NAME, derive } from "@commontools/builder";
import { z } from "zod";

// @ts-ignore this loads the html file using VITE.js as a string from the html file on disk
import src from "./smolIframe.html?raw";

const DataSchema = z.object({
  data: z
    .object({
      count: z.number().default(0),
    })
})
  .describe("SMOL Counter demo");

export default recipe(DataSchema, ({ data }) => {
  const { count } = data;
  return {
    [NAME]: "smol iframe",
    [UI]: (
      <div style="height: 100%">
        <p>outside of iframe, data: {derive({ count }, (data) => JSON.stringify(data))}</p>
        <common-iframe src={src} $context={data}></common-iframe>
      </div>
    ),
    count,
  };
});
