import smolIframeSrc from "./smolIframe.tsx?raw";
import smolIframe from "./smolIframe.js";
import { addRecipe } from "@commontools/runner";

addRecipe(smolIframe, smolIframeSrc);
export { smolIframe };
