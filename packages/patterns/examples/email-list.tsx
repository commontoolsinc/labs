/// <cts-enable />
import {
  computed,
  NAME,
  pattern,
  UI,
  VNode,
  wish,
  Writable,
} from "commontools";
import { Email } from "../google/core/gmail-importer.tsx";
import { Contact } from "../contacts/contact-detail.tsx";
import Suggestion from "../system/suggestion.tsx";

export default pattern<Record<string, never>>((_) => {
  const emailResult = wish<Email & { [UI]: VNode }>({
    query: "#email",
    scope: ["."],
  });

  const emails = emailResult.candidates;

  const peopleResult = wish<Contact & { [NAME]: string }>({
    query: "#person",
    scope: ["."],
  });

  const people = peopleResult.candidates;
  const selectedPerson = Writable.of<Contact | null>(null);
  const emailString = computed(() => {
    const result = [];
    for (const email of emailResult.candidates) {
      result.push(
        `Subject: ${email.subject}\nFrom: ${email.from}\nBody: ${email.plainText}`,
      );
    }
    return result;
  });

  const summary = Suggestion({
    situation:
      "Summarize the content of this email list to give the receiver a briefing",
    context: {
      emails: emailString,
    },
  });

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
        {summary}
        <hr />
        {emails}
        <hr />
        <pre>{emailString}</pre>
      </div>
    ),
  };
});
