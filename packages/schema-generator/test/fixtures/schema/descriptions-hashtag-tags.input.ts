/** A #note the user took, discoverable via #quick-capture. */
interface SchemaRoot {
  /** The note body. */
  content: string;
  /** Linked #annotation entries. */
  annotations: string[];
}
