// Note: We intentionally use console.log directly for debug output
// to ensure it's not suppressed by conditionalConsole

/**
 * Information about a transformation being performed
 */
export interface TransformerDebugInfo {
  /** The name of the transformer */
  transformerName: string;
  /** The file being transformed */
  fileName: string;
  /** Line and column information */
  location?: { line: number; column: number };
  /** The type of transformation being performed */
  transformationType: string;
  /** Additional context-specific details */
  details?: Record<string, any>;
  /** The code before transformation (optional) */
  before?: string;
  /** The code after transformation (optional) */
  after?: string;
}

/**
 * Interface for transformer debugging
 */
export interface TransformerDebugger {
  /** Log a transformation event */
  logTransformation(info: TransformerDebugInfo): void;
  /** Log general debug information */
  log(message: string, details?: Record<string, any>): void;
  /** Check if debugging is enabled */
  isEnabled(): boolean;
  /** Log the final transformed source (called by LoggingTransformer) */
  logTransformedSource?(fileName: string, source: string): void;
}

/**
 * Base options for all transformers
 */
export interface TransformerOptions {
  /** Show transformed source configuration */
  showTransformed?: boolean | TransformerDebugger;
}

/**
 * Standard implementation of TransformerDebugger
 */
export class StandardTransformerDebugger implements TransformerDebugger {
  constructor(
    private readonly transformerName: string,
    private readonly enabled: boolean = false,
    private readonly showTransformedOnly: boolean = false,
    private readonly logger: (message: string) => void = console.log // Use stdout for transformed source
  ) {}

  logTransformation(info: TransformerDebugInfo): void {
    if (!this.enabled || this.showTransformedOnly) return;
    
    const prefix = `[${info.transformerName}]`;
    const location = info.location 
      ? `${info.fileName}:${info.location.line}:${info.location.column}`
      : info.fileName;
    
    this.logger(`${prefix} ${info.transformationType} at ${location}`);
    
    if (info.details) {
      Object.entries(info.details).forEach(([key, value]) => {
        this.logger(`  ${key}: ${JSON.stringify(value)}`);
      });
    }
    
    if (info.before) {
      this.logger(`  Before: ${info.before}`);
    }
    
    if (info.after) {
      this.logger(`  After: ${info.after}`);
    }
  }

  log(message: string, details?: Record<string, any>): void {
    if (!this.enabled || this.showTransformedOnly) return;
    
    this.logger(`[${this.transformerName}] ${message}`);
    
    if (details) {
      Object.entries(details).forEach(([key, value]) => {
        this.logger(`  ${key}: ${JSON.stringify(value)}`);
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  logTransformedSource(fileName: string, source: string): void {
    if (!this.enabled) return;
    
    if (this.showTransformedOnly) {
      // When --show-transformed is used, only output the source code
      this.logger(source);
    } else {
      // When debugging, show with headers
      this.logger(`\n=== TRANSFORMED SOURCE: ${fileName} ===`);
      this.logger(source);
      this.logger(`=== END TRANSFORMED SOURCE ===\n`);
    }
  }
}

/**
 * Create a debugger instance for a transformer
 */
export function createDebugger(
  transformerName: string, 
  options: TransformerOptions
): TransformerDebugger {
  if (typeof options.showTransformed === 'object' && options.showTransformed) {
    return options.showTransformed;
  }
  
  return new StandardTransformerDebugger(
    transformerName,
    !!options.showTransformed,
    !!options.showTransformed, // showTransformedOnly flag
    console.log // Use stdout for transformed source output
  );
}

/**
 * Transformation types for type safety and consistency
 */
export const TRANSFORMATION_TYPES = {
  OPAQUE_REF: {
    TERNARY: 'ternary-to-ifelse',
    JSX_EXPRESSION: 'jsx-expression-wrap',
    BINARY_EXPRESSION: 'binary-to-derive',
    METHOD_CALL: 'method-call',
    PROPERTY_ACCESS: 'property-access',
    TEMPLATE_LITERAL: 'template-literal',
    OBJECT_SPREAD: 'object-spread',
    ELEMENT_ACCESS: 'element-access',
    FUNCTION_CALL: 'function-call'
  },
  SCHEMA: {
    TO_SCHEMA_CALL: 'to-schema-call',
    HANDLER_TYPE_ARGS: 'handler-type-args',
    RECIPE_TYPE_ARGS: 'recipe-type-args',
    TYPE_CONVERSION: 'type-conversion'
  }
} as const;

export type TransformationType = 
  | typeof TRANSFORMATION_TYPES.OPAQUE_REF[keyof typeof TRANSFORMATION_TYPES.OPAQUE_REF]
  | typeof TRANSFORMATION_TYPES.SCHEMA[keyof typeof TRANSFORMATION_TYPES.SCHEMA];