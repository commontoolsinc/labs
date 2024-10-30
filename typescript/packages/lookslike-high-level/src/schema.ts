export function zodSchemaToPlaceholder(schema: any): any {
  // Handle primitive types
  if (schema._def.typeName === 'ZodString') return 'string';
  if (schema._def.typeName === 'ZodNumber') return 0;
  if (schema._def.typeName === 'ZodBoolean') return false;
  if (schema._def.typeName === 'ZodDate') return new Date();
  if (schema._def.typeName === 'ZodNull') return null;
  if (schema._def.typeName === 'ZodUndefined') return undefined;

  // Handle arrays
  if (schema._def.typeName === 'ZodArray') {
    return [zodSchemaToPlaceholder(schema._def.type)];
  }

  // Handle objects
  if (schema._def.typeName === 'ZodObject') {
    const shape = schema._def.shape();
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(shape)) {
      result[key] = zodSchemaToPlaceholder(value);
    }

    return result;
  }

  // Handle unions
  if (schema._def.typeName === 'ZodUnion') {
    // Take the first option from the union
    return zodSchemaToPlaceholder(schema._def.options[0]);
  }

  // Handle optional
  if (schema._def.typeName === 'ZodOptional') {
    return zodSchemaToPlaceholder(schema._def.innerType);
  }

  // Handle nullable
  if (schema._def.typeName === 'ZodNullable') {
    return zodSchemaToPlaceholder(schema._def.innerType);
  }

  // Handle enums
  if (schema._def.typeName === 'ZodEnum') {
    return schema._def.values[0];
  }

  // Handle literals
  if (schema._def.typeName === 'ZodLiteral') {
    return schema._def.value;
  }

  // Default fallback
  return undefined;
}


export const jsonToDatalogQuery = (jsonObj: any) => {
  const select: Record<string, any> = {};
  const where: Array<any> = [];

  function processObject(obj: any, path: string, selectObj: any) {
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = path ? `${path}/${key}` : key;
      const varName = `?${currentPath}`.replace(/\//g, '_');

      if (Array.isArray(value)) {
        selectObj[key] = [{}];
        processObject(value[0], currentPath, selectObj[key][0]);
      } else if (typeof value === 'object' && value !== null) {
        selectObj[key] = {};
        processObject(value, currentPath, selectObj[key]);
      } else {
        selectObj[key] = varName;
        where.push({ Case: ['?item', currentPath, varName]});
      }
    }
  }

  select.id = '?item';
  processObject(jsonObj, '', select);

  return {
    select,
    where
  };
};
