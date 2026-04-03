/// <cts-enable />
import { fetchData, pattern, UI } from "commonfabric";

interface Item {
  name: string;
}

export default pattern<Record<string, never>>(() => {
  const { result: items } = fetchData<Item[]>({
    url: "https://example.com",
    result: [],
  });

  return {
    [UI]: <div>{items.map((item) => <span>{item.name}</span>)}</div>,
  };
});
