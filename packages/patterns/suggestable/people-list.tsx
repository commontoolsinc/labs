/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  wish,
} from "commontools";

// ===== Types =====

type PersonListInput = Record<string, never>;

type Person = {
  contact: {
    name: string;
    email: Default<string, "">;
  };
};

type PersonListOutput = {
  [NAME]: string;
  [UI]: VNode;
  people: Person[];
};

// ===== Pattern =====

const PersonList = pattern<PersonListInput, PersonListOutput>(() => {
  const people = wish<Person>({ query: "#person", scope: [".", "~"] });

  return {
    [NAME]: computed(() =>
      people.candidates?.length
        ? `People: ${people.candidates?.length}`
        : "People"
    ),
    [UI]: (
      <ct-vstack gap="2" style="padding: 1.5rem;">
        <div>
          {people.candidates.map((person) => (
            <ct-hstack gap="2" align="center">
              <span>{person.contact.name}</span>
              <span>{person.contact.email}</span>
            </ct-hstack>
          ))}
        </div>
      </ct-vstack>
    ),
    people: people.candidates,
  };
});

export default PersonList;
