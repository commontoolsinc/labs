import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe("MapSingleCapture", (_state) => {
    const people = cell([
        { id: "1", name: "Alice" },
        { id: "2", name: "Bob" },
    ]);
    return {
        [UI]: (<div>
        {__ctHelpers.derive(people, people => people.length > 0 && (<ul>
            {people.map((person) => (<li key={person.id}>{person.name}</li>))}
          </ul>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
