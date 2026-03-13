/// <cts-enable />
import { Default, NAME, pattern, UI, type VNode } from "commontools";

interface HomeInput {}

interface HomeOutput {
  [NAME]: string;
  [UI]: VNode;
}

const HomePattern = pattern<HomeInput, HomeOutput>(() => {
  return {
    [NAME]: "Home",
    [UI]: (
      <div>
        <p>The Home pattern</p>
        <div>
          <ct-link to="/books"></ct-link>
        </div>
      </div>
    ),
  };
});

interface BooksInput {}

interface BooksOutput {
  [NAME]: string;
  [UI]: VNode;
}

const BooksPattern = pattern<BooksInput, BooksOutput>(() => {
  return {
    [NAME]: "Books",
    [UI]: (
      <div>
        <p>The Books pattern</p>
        <div>
          <ct-link to="/"></ct-link>
        </div>
      </div>
    ),
  };
});

interface RouterInput {}

interface RouterOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<RouterInput, RouterOutput>(() => {
  return {
    [NAME]: "Router",
    [UI]: (
      <ct-screen>
        <ct-router-provider>
          <ct-route path="/">
            <HomePattern />
          </ct-route>
          <ct-route path="/books">
            <BooksPattern />
          </ct-route>
        </ct-router-provider>
      </ct-screen>
    ),
  };
});
