import smolIframeSrc from "./smolIframe.tsx?raw";
import smolIframe from "./smolIframe.tsx";
import { addRecipe } from "@commontools/runner";

addRecipe(smolIframe, smolIframeSrc);
export { smolIframe };
