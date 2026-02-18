/// <cts-enable />
import { toSchema } from "commontools";

interface LinkedData {
  "@link": string;
  "@context": string;
  "@type": string;
  "kebab-case": number;
  "with space": boolean;
  "with-special-chars!": string;
  "default": string;
  "enum": number;
  "class": boolean;
  normalProperty: string;
}

const linkedDataSchema = toSchema<LinkedData>();
export { linkedDataSchema };
