// Vendored form of the patch at https://github.com/lino-levan/astral/pull/166
// Once/if landed upstream, we can remove this handling
// TODO(js): Temporary workaround for upstream https://github.com/lino-levan/astral/pull/166

import type { Page } from "@astral/astral";
type DOM_NodeId = number;
type Celestial = ReturnType<typeof Page.prototype.unsafelyGetCelestialBindings>;

export interface QueryOpts {
  nodeId: DOM_NodeId;
  selector: string;
}

// Queries an element from the DOM from `parent` with `selector`.
// Supports CDP querying, and custom `pierce/*` selector.
export async function query(
  bindings: Celestial,
  opts: QueryOpts,
): Promise<DOM_NodeId | undefined> {
  if (opts.selector.startsWith("pierce/")) {
    return (await pierceQuerySelector(
      bindings,
      opts,
    ))[0];
  } else {
    const result = await bindings.DOM.querySelector(opts);
    return result?.nodeId;
  }
}

// Queries multiple elements from the DOM from `parent` with `selector`.
// Supports CDP querying, and custom `pierce/*` selector.
export async function queryAll(
  bindings: Celestial,
  opts: QueryOpts,
): Promise<DOM_NodeId[]> {
  if (opts.selector.startsWith("pierce/")) {
    return await pierceQuerySelector(bindings, opts, true);
  } else {
    const result = await bindings.DOM.querySelectorAll(opts);
    return result?.nodeIds ? result.nodeIds : [];
  }
}

async function pierceQuerySelector(
  bindings: Celestial,
  opts: QueryOpts,
  queryAll?: boolean,
): Promise<DOM_NodeId[]> {
  if (!opts.selector.startsWith("pierce/")) {
    throw new Error("Not a `pierce/` selector.");
  }
  const selector = opts.selector.substring("pierce/".length);

  const { object } = await bindings.DOM.resolveNode({
    nodeId: opts.nodeId,
  });

  const queryResult = await bindings.Runtime
    .callFunctionOn({
      functionDeclaration: contentPierceQuerySelector.toString(),
      objectId: object.objectId,
      arguments: [
        {
          objectId: object.objectId,
        },
        { value: selector },
        { value: queryAll },
      ],
      returnByValue: false,
    });

  if (queryResult.exceptionDetails) {
    throw queryResult.exceptionDetails;
  }

  const elementsId = queryResult.result.objectId;
  if (!elementsId) {
    return [];
  }

  const propsResult = await bindings.Runtime.getProperties({
    objectId: elementsId,
    ownProperties: true,
  });

  if (propsResult.exceptionDetails) {
    throw propsResult.exceptionDetails;
  }

  const nodeIds = (await Promise.all(
    propsResult.result.map((prop) => {
      if (prop.value && prop.value.objectId && !Number.isNaN(prop.name)) {
        return bindings.DOM.requestNode({
          objectId: prop.value.objectId,
        });
      }
    }).filter(Boolean) as Array<Promise<{ nodeId: DOM_NodeId }>>,
  )).map((result) => result.nodeId);

  return nodeIds;
}

// This function is executed in content, implementing
// the `pierce/` shadow piercing selector.
function contentPierceQuerySelector(
  element: Element,
  selector: string,
  queryAll: boolean,
): Element[] {
  const nodes: Element[] = [];

  function deepRecurse(node: Element) {
    if (!node.shadowRoot) {
      return;
    }

    const matches = Array.from(node.shadowRoot.querySelectorAll(selector));
    if (matches.length) {
      for (const match of matches) {
        nodes.push(match);
      }
      if (!queryAll) {
        return;
      }
    }

    const els = Array.from(node.shadowRoot.querySelectorAll("*")).filter((el) =>
      el.shadowRoot
    );
    for (const el of els) {
      deepRecurse(el);
    }
  }

  const els = Array.from(element.querySelectorAll("*")).filter((el) =>
    el.shadowRoot
  );
  for (const el of els) {
    deepRecurse(el);
  }
  return queryAll ? nodes : nodes.length ? [nodes[0]] : [];
}
