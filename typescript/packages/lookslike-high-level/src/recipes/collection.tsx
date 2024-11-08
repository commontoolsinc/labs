import { h } from "@commontools/common-html";
import { recipe, handler, UI, NAME, derive } from "@commontools/common-builder";
import { z } from "zod";
import {
  getCellReferenceOrThrow,
  run,
  isCellReference,
  getCellByEntityId,
} from "@commontools/common-runner";

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

export default recipe(
  z
    .object({
      title: z.string().default("untitled collection"),
      items: z.array(z.any()).default([]),
    })
    .describe("Collection"),
  ({ title, items }) => {
    return {
      [NAME]: title,
      [UI]: (
        <os-container>
          <common-input
            value={title}
            placeholder="List title"
            oncommon-input={updateTitle({ title })}
          />
          <os-colgrid>
            {items.map((item) => (
              <common-draggable $entity={item}>
                <common-card>
                  {derive(item, (item) =>
                    typeof item === "object" && item !== null ? (
                      item[UI] ? (
                        item[UI]
                      ) : item.type === "view" || item.type === "vnode" ? (
                        item
                      ) : (
                        <pre>{JSON.stringify(item, null, 2)}</pre>
                      )
                    ) : (
                      item
                    ),
                  )}
                </common-card>
              </common-draggable>
            ))}
          </os-colgrid>
        </os-container>
      ),
      title,
      items,
      "action/drop/schema": { type: "string" },
      "action/drop/handler": handler<any[], { items: any[] }>(
        (event, { items }) => {
          console.log("collection drag handler", event);
          const ref = getCellReferenceOrThrow(event);
          const list = ref.cell.getAtPath(ref.path);
          list?.forEach((item: any) => {
            // We do all this to find the spell parameter on the cell reference.
            // If it's there, create a new charm with it. Otherwise turn this
            // back into a query result proxy.
            if (isCellReference(item)) {
              // If there's a spell, run it to get the cell reference.
              const spell = (item as { spell?: string }).spell;
              if (spell)
                item = { cell: run(JSON.parse(spell), item), path: [] };
              // If there is a resultRef, let's use that instead.
              else if (
                item.path.length === 0 &&
                item.cell.getAtPath(["resultRef"])
              )
                item = item.cell.getAtPath(["resultRef"]);
              item = item.cell.getAsQueryResult(item.path);
            } else if (typeof item === "string") {
              const match = item.match(/https?:\/\/.*\/charm\/(.*)/);
              if (match) {
                const charmId = decodeURIComponent(match[1]);
                const cell = getCellByEntityId(charmId);
                if (cell) item = cell.getAsQueryResult();
              }
            }
            items.push(item);
          });
        },
      )({ items }),
    };
  },
);
