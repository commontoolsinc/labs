import { h } from "@commontools/html";
import { recipe, handler, UI, NAME, derive, lift, cell } from "@commontools/builder";
import { z } from "zod";

const ArticleItem = z.object({
  title: z.string(),
  url: z.string(),
});

export type ArticleItem = z.infer<typeof ArticleItem>;

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "untitled";
  },
);

const updateItem = handler<{ detail: { checked: boolean; value: string } }, { item: ArticleItem }>(
  ({ detail }, { item }) => {
    item.done = detail.checked;
  },
);

const deleteItem = handler<{}, { list: ArticleItem[]; item: ArticleItem }>(({}, { item, list }) => {
  let idx = list.findIndex((i) => i.title === item.title);
  if (idx !== -1) list.splice(idx, 1);
  console.log("deleted item", item, idx);
});

const oneWayCopyFn = lift(({ external, seen, internal }) => {
  const previousCells = seen.map((item: any) => JSON.stringify(item));
  console.log("previousCells", previousCells);
  external.forEach((item: any) => {
    if (!previousCells.includes(JSON.stringify(item))) {
      console.log("new item", item, JSON.stringify(item));
      seen.push(item);
      internal.push(item);
    }
  });
});

function oneWayCopy(external: any[]) {
  const seen = cell([]);
  const internal = cell([]);
  oneWayCopyFn({ external, seen, internal });
  return internal;
}

export default recipe(
  z
    .object({
      title: z.string().default("Reading list"),
      articles: z.array(ArticleItem).default([]).describe("#readinglist"),
    })
    .describe("Reading list 2"),
  ({ title, articles }) => {
    const list = oneWayCopy(articles);
    return {
      [NAME]: title,
      [UI]: (
        <os-container>
          <common-input
            value={title}
            placeholder="List title"
            oncommon-input={updateTitle({ title })}
          />
          <div
            class="card-grid"
            style="display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem;"
          >
            {list.map((item: ArticleItem) => (
              <common-draggable $entity={item}>
                <sl-card>
                  <h3 slot="header">{item.title}</h3>
                  <div>
                    <a href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.url}
                    </a>
                  </div>
                </sl-card>
              </common-draggable>
            ))}
          </div>
        </os-container>
      ),
      title,
      list,
    };
  },
);
