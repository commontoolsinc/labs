import { addRecipe } from "@commontools/runner";

import chatSrc from "./chatty.tsx?raw";
import { chat } from "./chatty.js";
addRecipe(chat, chatSrc);
export { chat };

import closuresSrc from "./closures.tsx?raw";
import closures from "./closures.js";
addRecipe(closures, closuresSrc);
export { closures };

import commentboxSrc from "./commentbox.tsx?raw";
import commentbox from "./commentbox.js";
addRecipe(commentbox, commentboxSrc);
export { commentbox };

import collectionSrc from "./collection.tsx?raw";
import collection from "./collection.js";
addRecipe(collection, collectionSrc);
export { collection };

import counterSrc from "./counter.tsx?raw";
import counter from "./counter.js";
addRecipe(counter, counterSrc);
export { counter };

import countersSrc from "./counters.tsx?raw";
// @ts-ignore - it wants this to be a proper module
import counterSpec from "./counters.md?raw";
import counters from "./counters.js";
addRecipe(counters, countersSrc, counterSpec);
export { counters };

import dataDesignerSrc from "./dataDesigner.tsx?raw";
import { dataDesigner } from "./dataDesigner.js";
addRecipe(dataDesigner, dataDesignerSrc);
export { dataDesigner };

import fetchExampleSrc from "./fetchExample.tsx?raw";
import { fetchExample } from "./fetchExample.js";
addRecipe(fetchExample, fetchExampleSrc);
export { fetchExample };

import generatorSrc from "./generator.tsx?raw";
import { generator } from "./generator.js";
addRecipe(generator, generatorSrc);
export { generator };

import generativeImageSrc from "./generativeImage.tsx?raw";
import { generativeImage } from "./generativeImage.js";
addRecipe(generativeImage, generativeImageSrc);
export { generativeImage };

import importCalendarSrc from "./archive/importCalendar.tsx?raw";
import { importCalendar } from "./archive/importCalendar.js";
addRecipe(importCalendar, importCalendarSrc);
export { importCalendar };

import jsonImporterSrc from "./archive/jsonImport.tsx?raw";
import { jsonImporter } from "./archive/jsonImport.js";
addRecipe(jsonImporter, jsonImporterSrc);
export { jsonImporter };

import luftBnBSearchSrc from "./luft-bnb-search.tsx?raw";
import { luftBnBSearch } from "./luft-bnb-search.js";
addRecipe(luftBnBSearch, luftBnBSearchSrc);
export { luftBnBSearch };

import promptSrc from "./prompts.tsx?raw";
import { prompt } from "./prompts.js";
addRecipe(prompt, promptSrc);
export { prompt };

import playlistForTripSrc from "./playlist.tsx?raw";
import { playlistForTrip } from "./playlist.js";
addRecipe(playlistForTrip, playlistForTripSrc);
export { playlistForTrip };

import readingListSrc from "./reading-list.tsx?raw";
import readingList from "./reading-list.js";
addRecipe(readingList, readingListSrc);
export { readingList };

import routineSrc from "./routine.ts?raw";
import { routine } from "./routine.js";
addRecipe(routine, routineSrc);
export { routine };

import shoelaceDemoSrc from "./examples/shoelace.tsx?raw";
import { shoelaceDemo } from "./examples/shoelace.js";
addRecipe(shoelaceDemo, shoelaceDemoSrc);
export { shoelaceDemo };

import todoListSrc from "./todo-list.tsx?raw";
import todoList from "./todo-list.js";
addRecipe(todoList, todoListSrc);
export { todoList };

import wikiSrc from "./wiki.tsx?raw";
import wiki from "./wiki.js";
addRecipe(wiki, wikiSrc);
export { wiki };
