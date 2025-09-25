/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  recipe,
  UI,
} from "commontools";

/** Extract pizza descriptions from a web-read content blob. */
function extractPizzas(content: string): string[] {
  const marker = "### Pizza";
  if (!content.includes(marker)) {
    return [];
  }

  const sections: string[] = [];
  const parts = content.split(marker).slice(1);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const headingIndex = trimmed.indexOf("### ");
    const slice = headingIndex === -1
      ? trimmed
      : trimmed.slice(0, headingIndex).trim();

    if (slice) {
      sections.push(slice);
    }
  }
  return sections;
}

/** Shape of the Toolshed web-read response we care about. */
type WebReadResult = {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    date?: string;
    word_count: number;
  };
};

/** Reactive system will call this lift when the fetched data
  is updated. it also allows us to call our pure function
  `extractPizzas` and return the results
*/
const createPizzaListCell = lift<{ result: WebReadResult }, string[]>(
  ({ result }) => {
    return extractPizzas(result?.content ?? "");
  },
);

export default recipe("Cheeseboard", () => {
  const cheeseBoardUrl =
    "https://cheeseboardcollective.coop/home/pizza/pizza-schedule/";
  const { result, pending, error } = fetchData<WebReadResult>({
    url: "/api/agent-tools/web-read",
    mode: "json",
    options: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        url: cheeseBoardUrl,
        max_tokens: 4000,
      },
    },
  });

  const pizzaList = createPizzaListCell({ result });

  return {
    [NAME]: "Cheeseboard",
    [UI]: (
      <div>
        <h2>Cheeseboard</h2>
        <div>
          Pizza list:
          {derive(pizzaList, (l) => l ? JSON.stringify(l) : "")}
        </div>
        {/* <div>Full page: { result ? result : "No Result Yet"  }</div> */}
      </div>
    ),
  };
});
