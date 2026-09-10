import { assert, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../test/vnode-helpers.ts";
import GoogleDocsImporter from "./google-docs-importer.tsx";

export default pattern(() => {
  const subject = GoogleDocsImporter({});

  const assert_built = assert(() => subject != null);
  const assert_no_url = assert(() => subject.docUrl === "");
  const assert_no_markdown = assert(() => subject.markdown === "");
  const assert_no_title = assert(() => subject.docTitle === "");
  const assert_header_rendered = assert(() =>
    hasText(subject[UI], "Google Docs Markdown Importer")
  );
  // Google is not signed in here, so the importer offers the URL field and
  // waits rather than reaching for a document.
  const assert_url_field_rendered = assert(() =>
    hasText(subject[UI], "Google Doc URL")
  );

  return {
    [TESTS]: [
      { assertion: assert_built },
      { assertion: assert_no_url },
      { assertion: assert_no_markdown },
      { assertion: assert_no_title },
      { assertion: assert_header_rendered },
      { assertion: assert_url_field_rendered },
    ],
    subject,
  };
});
