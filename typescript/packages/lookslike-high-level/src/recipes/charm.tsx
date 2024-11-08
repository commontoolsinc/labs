import { h, behavior, $, Reference, select, View } from "@commontools/common-system";
import { view } from "../sugar.jsx";
import { analyzeRuleDependencies } from "../viz.js";

export const source = { clicker: { v: 33 } };

const init = select({ self: $.self })
  .not.match($.self, "clicks", $._)
  .assert(({ self }) => [self, "clicks", 0])
  .commit();

// // can use q.clicks(0) to express the default
const viewCount = view(q => {
  return (
    <div title={`Clicks ${q.clicks}`} entity={q.self}>
      <div>{q.clicks}</div>
      <button onclick="~/on/click">Click me!</button>
    </div>
  );
});

const onReset = select({
  self: $.self,
  event: $.event,
})
  .match($.self, "~/on/reset", $.event)
  .upsert(({ self }) => [self, "clicks", 0])
  .commit();

const onClick = select({
  self: $.self,
  count: $.count,
  event: $.event,
})
  .match($.self, "clicks", $.count)
  .match($.self, "~/on/click", $.event)
  .upsert(({ self, count }) => [self, "clicks", count + 1])
  .commit();

export const rules = behavior({
  init,
  viewCount,
  onClick,
  onReset
});

const clauses = rules.rules;
const mermaid = analyzeRuleDependencies(rules.rules as any)
debugger

export const spawn = (input: {} = source) => rules.spawn(input);
