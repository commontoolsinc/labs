import { addModuleByRef, raw } from "../module.ts";
import { map } from "./map.ts";
import { fetchData } from "./fetch-data.ts";
import { streamData } from "./stream-data.ts";
import { llm } from "./llm.ts";
import { ifElse } from "./if-else.ts";

addModuleByRef("map", raw(map));
addModuleByRef("fetchData", raw(fetchData));
addModuleByRef("streamData", raw(streamData));
addModuleByRef("llm", raw(llm));
addModuleByRef("ifElse", raw(ifElse));
