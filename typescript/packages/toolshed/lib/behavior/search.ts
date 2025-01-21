import { State, BehaviourTree } from "mistreevous";

const definition = `root {
    sequence {
        action [Walk]
        action [Fall]
        action [Laugh]
    }
}`;

/** Create an agent that we will be modelling the behaviour for. */
const agent = {
  Walk: () => {
    console.log("walking!");
    return State.SUCCEEDED;
  },
  Fall: () => {
    console.log("falling!");
    return State.SUCCEEDED;
  },
  Laugh: () => {
    console.log("laughing!");
    return State.SUCCEEDED;
  },
};

/** Create the behaviour tree, passing our tree definition and the agent that we are modelling behaviour for. */
const behaviourTree = new BehaviourTree(definition, agent);

/** Step the tree. */
behaviourTree.step();
