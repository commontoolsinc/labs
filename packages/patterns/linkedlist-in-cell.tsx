/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  NAME,
  recipe,
  UI,
} from "commontools";

interface LinkedList {
  value: string;
  next?: LinkedList;
}

interface InputSchema {
  title: Default<string, "untitled">;
}

type InputEventType = {
  detail: {
    message: string;
  };
};

interface ListState {
  items_list: Cell<LinkedList>;
}

// Helper function to copy a linked list
function copyList(list: LinkedList): LinkedList {
  return {
    value: list.value,
    next: list.next ? copyList(list.next) : undefined,
  };
}

// Helper function to add a node to the linked list
// copy the list because it has reactive symbols in it
// FIXME(@ellyxir): why do these symbols break things?
function addNodeToList(list: LinkedList, value: string): LinkedList {
  return {
    value: value,
    next: copyList(list),
  };
}

function listToString(
  list: LinkedList | null | undefined,
  separator: string = " -> ",
): string {
  if (!list) return "";
  if (!list.next) return list.value;
  return list.value + separator + listToString(list.next, separator);
}

const addItem = handler<InputEventType, ListState>(
  (event: InputEventType, state: ListState) => {
    // Add node to linked list
    const currentList = state.items_list.get();
    const newList = addNodeToList(currentList, event.detail.message);
    state.items_list.set(newList);
  },
);

export default recipe("Simple LinkedList", ({ title }: InputSchema) => {
  const items_list = cell<LinkedList>({ value: "1" });

  // Create a derived value for the linked list string representation
  // FIXME(@ellyxir): use inputschema instead of just creating it here
  const linkedListString = derive(
    items_list,
    (list) => listToString(list, "\n"),
  );

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h3>{title}</h3>
        <p>Super Simple LinkedList</p>
        <common-send-message
          name="Send"
          placeholder="Type a message..."
          appearance="rounded"
          onmessagesend={addItem({ items_list })}
        />
        <div
          style={{
            marginTop: "20px",
            padding: "10px",
            backgroundColor: "#f5f5f5",
          }}
        >
          <h4>Linked List:</h4>
          <pre style={{ fontFamily: "monospace" }}>{linkedListString}</pre>
        </div>
      </div>
    ),
    title,
    addItem: addItem({ items_list }),
  };
});
