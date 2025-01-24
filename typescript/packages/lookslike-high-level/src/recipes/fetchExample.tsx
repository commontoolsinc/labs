import { h } from "@commontools/common-html";
import {
  recipe,
  fetchData,
  UI,
  handler,
  NAME,
  lift,
} from "@commontools/common-builder";

interface Item {
  id: string;
  title: string;
}

// FIXME(ja): there is a bug when the list gets smaller item map fails to shrink
//   you can see this by returning [{"id": "1", "title": "smaller"}] if results is null
const maybeList = lift(({ result }) => {
  return result || [];
});

const updateUrl = handler<{ detail: { value: string } }, { url: string }>(
  ({ detail }, state) => {
    state.url = detail?.value ?? "untitled";
  },
);

// FIXME(ja): integrate jsonImport / dataDesigner ability to work with arbitrary schema
export const fetchExample = recipe<{ url: string }>(
  "Fetch Example",
  ({ url }) => {
    url.setDefault("https://anotherjesse-restfuljsonblobapi.web.val.run/items");

    const { result } = fetchData<Item[]>({ url });
    const items = maybeList({ result });

    return {
      [NAME]: "Fetch Example",
      [UI]: (
        <div>
          <common-input
            value={url}
            placeholder="Fetch url"
            oncommon-input={updateUrl({ url })}
          ></common-input>
          <ul>
            {items.map(({ title, id }) => (
              <li>
                {title} - {id}
              </li>
            ))}
          </ul>
        </div>
      ),
      result,
    };
  },
);
