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

const speciesNameUI = SerializedGeneratedUI("speciesName", {
  inputs: { prompt: { shape: { kind: "string", default: "Enter the name of the monster species:" } } },
  outputs: { speciesName: { shape: { kind: "string", default: "" } } }
});

const weightNode = TextLLMNode({
  inputs: {
    speciesName: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Generate the weight of a {{speciesName}} monster in kilograms." } }
  },
  outputs: { result: { shape: { kind: "number", default: 0, description: "generated weight" } } }
});

const heightNode = TextLLMNode({
  inputs: {
    speciesName: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Generate the height of a {{speciesName}} monster in meters." } }
  },
  outputs: { result: { shape: { kind: "number", default: 0, description: "generated height" } } }
});

const lifespanNode = TextLLMNode({
  inputs: {
    speciesName: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Generate the expected lifespan of a {{speciesName}} monster in years." } }
  },
  outputs: { result: { shape: { kind: "number", default: 0, description: "generated lifespan" } } }
});

const offspringNode = TextLLMNode({
  inputs: {
    speciesName: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Generate the number of offspring a {{speciesName}} monster typically has." } }
  },
  outputs: { result: { shape: { kind: "number", default: 0, description: "generated number of offspring" } } }
});

const lifecycleNode = TextLLMNode({
  inputs: {
    speciesName: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Describe the lifecycle of a {{speciesName}} monster in less than 150 words." } }
  },
  outputs: { result: { shape: { kind: "string", default: "", description: "generated lifecycle" } } }
});

const environmentNode = TextLLMNode({
  inputs: {
    speciesName: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Describe the environment of a {{speciesName}} monster in less than 150 words." } }
  },
  outputs: { result: { shape: { kind: "string", default: "", description: "generated environment" } } }
});

const monsterDisplay = SerializedGeneratedUI("monsterDisplay", {
  inputs: {
    speciesName: { shape: { kind: "string", default: "", description: "Display the generated monster species name with appropriate styling." } },
    weight: { shape: { kind: "number", default: 0, description: "Display the generated weight." } },
    height: { shape: { kind: "number", default: 0, description: "Display the generated height." } },
    lifespan: { shape: { kind: "number", default: 0, description: "Display the generated lifespan." } },
    offspring: { shape: { kind: "number", default: 0, description: "Display the generated number of offspring." } },
    lifecycle: { shape: { kind: "string", default: "", description: "Display the generated lifecycle description." } },
    environment: { shape: { kind: "string", default: "", description: "Display the generated environment description." } },
    prompt: { shape: { kind: "string", default: "Display each field neatly in a table." } }
  },
  outputs: {}
});

ground(speciesNameUI.out.ui);
ground(monsterDisplay.out.ui);

connect(speciesNameUI.out.speciesName, weightNode.in.speciesName);
connect(speciesNameUI.out.speciesName, heightNode.in.speciesName);
connect(speciesNameUI.out.speciesName, lifespanNode.in.speciesName);
connect(speciesNameUI.out.speciesName, offspringNode.in.speciesName);
connect(speciesNameUI.out.speciesName, lifecycleNode.in.speciesName);
connect(speciesNameUI.out.speciesName, environmentNode.in.speciesName);

connect(weightNode.out.result, monsterDisplay.in.weight);
connect(heightNode.out.result, monsterDisplay.in.height);
connect(lifespanNode.out.result, monsterDisplay.in.lifespan);
connect(offspringNode.out.result, monsterDisplay.in.offspring);
connect(lifecycleNode.out.result, monsterDisplay.in.lifecycle);
connect(environmentNode.out.result, monsterDisplay.in.environment);
