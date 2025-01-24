import { addModuleByRef, raw } from "../module.js";
import { map } from "./map.js";
import { fetchData } from "./fetch-data.js";
import { streamData } from "./stream-data.js";
import { llm } from "./llm.js";
import { ifElse } from "./if-else.js";

addModuleByRef("map", raw(map));
addModuleByRef("fetchData", raw(fetchData));
addModuleByRef("streamData", raw(streamData));
addModuleByRef("llm", raw(llm));
addModuleByRef("ifElse", raw(ifElse));
