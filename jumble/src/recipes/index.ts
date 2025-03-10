import smolIframeSrc from "./smolIframe.tsx?raw";
import smolIframe from "./smolIframe.tsx";
import { addRecipe } from "@commontools/runner";

// Cast the source to string to fix TypeScript error
addRecipe(smolIframe, smolIframeSrc as unknown as string);
export { smolIframe };
