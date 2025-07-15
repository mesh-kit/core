/**
 * Performs a deep merge of two objects, recursively merging nested objects
 * while preserving properties from the target that aren't specified in the source.
 *
 * @param target - The target object to merge into
 * @param source - The source object to merge from
 * @returns A new object with the merged properties
 */
export function deepMerge(target: any, source: any): any {
  if (!isObject(target) || !isObject(source)) {
    return source;
  }

  const result = { ...target };

  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (isObject(source[key]) && isObject(target[key])) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }

  return result;
}

export function isObject(value: any): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

