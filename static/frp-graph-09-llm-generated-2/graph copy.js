import {
  combineLatest,
  debounceTime,
  delay,
  distinctUntilChanged,
  filter,
  from,
  fromEvent,
  map,
  mergeMap,
  BehaviorSubject,
  share,
  switchMap,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { connect, ground } from "./connect.js";
import { SerializedGeneratedUI } from "./nodes/SerializedGeneratedUI.js";
import { TextLLMNode } from "./nodes/TextLLMNode.js";
import { CodeNode } from "./nodes/CodeNode.js";
const nameInput = SerializedGeneratedUI("nameInput", {
  inputs: { prompt: { shape: { kind: "string", default: "Enter your name:" } } },
  outputs: { name: { shape: { kind: "string", default: "" } } }
});

const colorInput = SerializedGeneratedUI("colorInput", {
  inputs: { prompt: { shape: { kind: "string", default: "Enter your favorite color:" } } },
  outputs: { color: { shape: { kind: "string", default: "" } } }
});

const poemGenerationNode = TextLLMNode({
  inputs: {
    name: { shape: { kind: "string" } },
    color: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Write a poem about {{name}} whose favorite color is {{color}}." } }
  },
  outputs: { result: { shape: { kind: "string", default: "", description: "generated poem" } } }
});

const poemDisplay = SerializedGeneratedUI("poemDisplay", {
  inputs: { poem: { shape: { kind: "string", default: "", description: "Display the generated poem with appropriate styling." } } },
  outputs: {}
});

ground(nameInput.out.ui);
ground(colorInput.out.ui);
ground(poemDisplay.out.ui);

connect(nameInput.out.name, poemGenerationNode.in.name);
connect(colorInput.out.color, poemGenerationNode.in.color);
connect(poemGenerationNode.out.result, poemDisplay.in.poem);
