/// <cts-enable />
import { computed, NAME, pattern, UI, type VNode, Writable } from "commontools";
import { type RouteContext, Router } from "./router.tsx";

// deno-lint-ignore no-empty-interface
interface HomeInput {}

interface HomeOutput {
  [NAME]: string;
  [UI]: VNode;
}

// deno-lint-ignore no-empty-interface
interface BooksInput {}

interface BooksOutput {
  [NAME]: string;
  [UI]: VNode;
}

interface BookInput {
  route: RouteContext;
}

interface BookOutput {
  [NAME]: string;
  [UI]: VNode;
}

// deno-lint-ignore no-empty-interface
interface MainInput {}

interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
}

const Home = pattern<HomeInput, HomeOutput>(() => {
  return {
    [NAME]: "Home",
    [UI]: (
      <div>
        <p>The Home pattern</p>
        <div>
          <ct-link to="/books">
            <a href="/books">Books</a>
          </ct-link>
        </div>
      </div>
    ),
  };
});

const Books = pattern<BooksInput, BooksOutput>(() => {
  return {
    [NAME]: "Books",
    [UI]: (
      <div>
        <p>The Books pattern</p>
        <div>
          <ct-link to="/books/1">
            <button type="button">Book 1</button>
          </ct-link>
        </div>
        <div>
          <ct-link to="/books/2?edition=hardcover">
            <button type="button">Book 2 (Hardcover)</button>
          </ct-link>
        </div>
      </div>
    ),
  };
});

const Book = pattern<BookInput, BookOutput>(({ route }) => {
  const bookId = computed(() => route.params.id);
  const edition = computed(() => route.query.edition || "unknown");
  return {
    [NAME]: computed(() => `Book ${bookId}`),
    [UI]: (
      <div>
        <p>Book ID: {bookId}</p>
        <p>Edition: {edition}</p>
        <div>
          <ct-link to="/books">
            <button type="button">Back to Books</button>
          </ct-link>
        </div>
        <div>
          <ct-link to="/">
            <button type="button">Home</button>
          </ct-link>
        </div>
      </div>
    ),
  };
});

export default pattern<MainInput, MainOutput>(() => {
  const routeContext = Writable.of<RouteContext>({
    path: "/",
    params: {},
    query: {},
  });

  const { path, Pattern } = Router({
    routeContext,
    routes: [
      { path: "/", pattern: Home({}) },
      { path: "/books", pattern: Books({}) },
      { path: "/books/{id}", pattern: Book({ route: routeContext }) },
    ],
  });

  return {
    [NAME]: "Main",
    [UI]: (
      <ct-screen>
        <div>Current path: {path}</div>
        <main>
          {Pattern}
        </main>
      </ct-screen>
    ),
  };
});
