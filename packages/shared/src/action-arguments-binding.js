import { createHash } from 'node:crypto';

// Only lossless JSON values may be bound across the Core/B HTTP boundary.
// Object order is immaterial; missing values, accessors and special objects are not silently coerced.
export function actionArgumentsBinding(value) {
  const ancestors = new Set();
  function encode(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || ancestors.has(item)) throw new Error('non-json-arguments');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error('non-json-object');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('symbol-arguments');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array && Object.keys(item).length !== item.length) throw new Error('non-json-array');
    const keys = array ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item).sort();
    if (Object.getOwnPropertyNames(item).length !== keys.length + (array ? 1 : 0)) throw new Error('non-enumerable-arguments');
    const values = keys.map(key => {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new Error('non-json-property');
      return `${array ? '' : JSON.stringify(key) + ':'}${encode(descriptor.value)}`;
    });
    ancestors.delete(item);
    return array ? `[${values.join(',')}]` : `{${values.join(',')}}`;
  }
  try {
    return { version: 'e-action-arguments-v1', argumentsSha256: createHash('sha256').update(encode(value)).digest('hex') };
  } catch { return null; }
}
