/// <cts-enable />
import {
  computed,
  DID,
  NAME,
  pattern,
  UI,
  VNode,
  wish,
  Writable,
} from "commontools";
import { Email } from "../google/core/gmail-importer.tsx";
import { Contact } from "../contacts/contact-detail.tsx";

export default pattern<Record<string, never>>((_) => {
  const emailResult = wish<
    { [UI]: VNode; candidates: (Email & { [UI]: VNode })[] }
  >({
    query: "#email",
    scope: ["."],
  });

  const emails = emailResult.result.candidates;

  const peopleResult = wish<
    { [UI]: VNode; candidates: (Contact & { [NAME]: string })[] }
  >({
    query: "#person",
    scope: ["."],
  });

  const people = peopleResult.result.candidates;
  const selectedPerson = Writable.of<Contact | null>(null);

  return {
    [NAME]: computed(() => "Email list (" + emails.length + ")"),
    [UI]: (
      <div>
        <ct-select
          items={people.map((p) => ({
            label: p[NAME],
            value: p,
          }))}
          $value={selectedPerson}
        />
        <hr />
        {emails}
      </div>
    ),
  };
});
