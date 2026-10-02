export const PUBLIC_SPEC_URL = 'https://hoplite.sh/docs/openapi.json';
export const MAX_SPEC_BYTES = 8 * 1024 * 1024;

export const TOOLKIT_ROUTES = [
  ['GET', '/api/model-providers'],
  ['GET', '/api/projects'],
  ['GET', '/api/projects/{id}'],
  ['GET', '/api/source-control/github/repositories'],
  ['GET', '/api/source-control/github/repositories/{id}/branches'],
  ['GET', '/api/source-control/github/repositories/{id}/inspect'],
  ['GET', '/api/threads'],
  ['POST', '/api/threads'],
  ['GET', '/api/threads/{id}'],
  ['GET', '/api/threads/{id}/runs'],
  ['GET', '/api/threads/{id}/run-state'],
  ['GET', '/api/threads/{id}/active-run'],
  ['GET', '/api/threads/{id}/messages'],
  ['POST', '/api/threads/{id}/messages'],
  ['POST', '/api/threads/{id}/stop'],
  ['POST', '/api/threads/{id}/retry'],
  ['POST', '/api/threads/{id}/compact'],
  ['GET', '/api/threads/{id}/usage'],
  ['GET', '/api/threads/{id}/pr/status'],
  ['GET', '/api/threads/{id}/pr/comments'],
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
type Route = readonly [string, string];

const ANNOTATIONS = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs']);
const MAPS = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
  'content', 'responses', 'headers', 'encoding', 'links', 'mapping',
]);
const LITERALS = new Set(['default', 'const', 'enum']);

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ObjectValue;
}

function pointerPart(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function buildApiContract(input: unknown, routes: readonly Route[] = TOOLKIT_ROUTES): ObjectValue {
  const spec = object(input, 'OpenAPI document');
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.')) {
    throw new Error('Expected an OpenAPI 3 document');
  }
  const paths = object(spec.paths, 'OpenAPI paths');
  let visited = 0;

  function lookup(ref: Json): Json {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) {
      throw new Error('Only local JSON-pointer references are supported; external references are never fetched');
    }
    let value: Json = spec;
    let parts: string[];
    try {
      parts = decodeURIComponent(ref.slice(2)).split('/');
    } catch {
      throw new Error('Invalid JSON-pointer reference');
    }
    for (const part of parts) {
      if (/~(?:[^01]|$)/.test(part)) throw new Error('Invalid JSON-pointer escape');
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) {
        throw new Error(`Unresolved local reference: ${ref.slice(0, 160)}`);
      }
      value = (value as ObjectValue)[key];
    }
    return value;
  }

  function normalize(value: Json, stack: readonly string[] = [], depth = 0, mode = 'object'): Json {
    if (++visited > 200_000 || depth > 80) throw new Error('Contract expansion exceeded its node/depth bound');
    if (Array.isArray(value)) {
      return value.map(item => normalize(item, stack, depth + 1, mode));
    }
    if (!value || typeof value !== 'object') return value;
    if (mode === 'object' && Object.hasOwn(value, '$ref')) {
      const ref = value.$ref;
      const target = lookup(ref);
      if (typeof ref !== 'string') throw new Error('Invalid reference');
      if (!stack.includes(ref)) {
        const resolved = normalize(target, [...stack, ref], depth + 1);
        const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref'));
        const normalizedSiblings = object(normalize(siblings, stack, depth + 1), 'Reference siblings');
        if (Object.keys(normalizedSiblings).length === 0) return resolved;
        // Preserve schema siblings as conjunctions instead of overwriting the referenced schema.
        return { allOf: [resolved, normalizedSiblings] };
      }
      // A back edge retains the reference; the target was already fully visited on this branch.
    }
    return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
      if (mode === 'object' && ANNOTATIONS.has(key)) return [];
      const childMode = mode === 'literal' ? 'literal'
        : mode === 'map' ? 'object'
        : LITERALS.has(key) ? 'literal' : MAPS.has(key) ? 'map' : 'object';
      let child = normalize(value[key], stack, depth + 1, childMode);
      if (mode === 'object' && (key === 'required' || key === 'enum') && Array.isArray(child)) {
        child = child.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      }
      return [[key, child]];
    }));
  }

  const operations: ObjectValue = {};
  for (const [method, path] of routes) {
    const label = `${method} ${path}`;
    const rawPath = object(paths[path], `Missing route ${label}`);
    const pathItem = rawPath.$ref === undefined ? rawPath : object(lookup(rawPath.$ref), `Path ${label}`);
    const operation = object(pathItem[method.toLowerCase()], `Missing operation ${label}`);
    if (typeof operation.operationId !== 'string' || !operation.operationId) {
      throw new Error(`Missing operationId: ${label}`);
    }
    object(operation.responses, `Missing responses: ${label}`);
    const parameters = new Map<string, Json>();
    for (const source of [pathItem.parameters ?? [], operation.parameters ?? []]) {
      if (!Array.isArray(source)) throw new Error(`Invalid parameters: ${label}`);
      for (const parameter of source) {
        const normalized = object(normalize(parameter), `Parameter: ${label}`);
        if (typeof normalized.in !== 'string' || typeof normalized.name !== 'string') {
          throw new Error(`Parameter must have in/name: ${label}`);
        }
        parameters.set(`${normalized.in}:${normalized.name}`, normalized);
      }
    }
    operations[label] = {
      method,
      path,
      operationId: operation.operationId,
      parameters: [...parameters.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value),
      requestBody: normalize(operation.requestBody ?? null),
      responses: normalize(operation.responses, [], 0, 'map'),
    };
  }
  return { formatVersion: 1, source: PUBLIC_SPEC_URL, operations };
}

export function contractDifferences(expected: unknown, actual: unknown, limit = 20): string[] {
  const differences: string[] = [];
  function compare(left: unknown, right: unknown, path: string): void {
    if (differences.length >= limit || Object.is(left, right)) return;
    if (left && right && typeof left === 'object' && typeof right === 'object'
        && Array.isArray(left) === Array.isArray(right)) {
      const a = left as Record<string, unknown>;
      const b = right as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        compare(a[key], b[key], `${path}/${pointerPart(key)}`);
        if (differences.length >= limit) break;
      }
    } else {
      differences.push(path.slice(0, 400) || '/');
    }
  }
  compare(expected, actual, '');
  return differences;
}
