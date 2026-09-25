/** The subset of JSON Schema the app's tool definitions use (MCP and voice). */
export type JsonSchema =
  | {
      type: 'object';
      properties?: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
      description?: string;
    }
  | { type: 'array'; items: JsonSchema; description?: string }
  | { type: 'string'; enum?: string[]; description?: string }
  | { type: 'number' | 'integer' | 'boolean'; description?: string }
  | { anyOf: JsonSchema[]; description?: string };

/** A schema for a tool's arguments or result: always an object. */
export type ObjectSchema = Extract<JsonSchema, { type: 'object' }>;
