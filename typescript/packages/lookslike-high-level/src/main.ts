import { render } from "@commontools/common-ui";
import { dataGems } from "./data.js";

const [vdom, bindings] = dataGems["todo list"].UI;

const element = render.render(vdom, bindings);

document.body.appendChild(element);
