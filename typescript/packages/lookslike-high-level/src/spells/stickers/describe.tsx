import { behavior, $, select } from "@commontools/common-system";
import { llm, RESPONSE } from "../../effects/fetch.jsx";
import { field } from "../../sugar.js";
import { log } from "../../sugar/activity.js";

export const description = field("llmDescription", "");

export const Description = (
  fields: string[],
  promptFn: (values: Record<string, any>) => string,
) => {
  return behavior({
    "description/generate": select({
      self: $.self,
      ...Object.fromEntries(fields.map(f => [f, $[f]])),
    })
      .matches(...fields.map(f => [$.self, f, $[f]] as any))
      .update((values: any) => [
        llm(values.self, "my/describe", {
          prompt: promptFn(Object.fromEntries(fields.map(f => [f, values[f]]))),
        }).json(),
        ...log(values.self, 'Generating description of: ' + promptFn(Object.fromEntries(fields.map(f => [f, values[f]]))))
      ])
      .commit(),

    "description/save": select({
      self: $.self,
      request: $.request,
      description: $.description,
    })
      .match($.self, "my/describe", $.request)
      .match($.request, RESPONSE.JSON, $.content)
      .match($.content, "content", $.description)
      .update(({ self, description }) => [
        { Upsert: [self, "llmDescription", description] },
      ])
      .commit(),
  });
};
