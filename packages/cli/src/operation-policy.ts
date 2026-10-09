import { directOperations, type OperationMetadata } from './generated/operations';

export type DirectOperation = OperationMetadata;
export type McpWriteKind = 'create' | 'message' | 'stop' | 'retry' | 'compact' | 'title';

const APPROVED_WRITE_KINDS: Readonly<Record<string, Exclude<McpWriteKind, 'title'>>> = {
  createThread: 'create',
  appendThreadMessage: 'message',
  stopRun: 'stop',
  retryThread: 'retry',
  compactThread: 'compact',
};

function templateMatches(template: string, path: string): boolean {
  const expression = template.split('/').map(segment => {
    if (/^\{[^{}]+\}$/.test(segment)) return '[^/]+';
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp(`^${expression}$`).test(path);
}

export function matchDirectOperation(
  method: string,
  path: string,
  operations: readonly DirectOperation[] = directOperations,
): DirectOperation | undefined {
  const staticRoutes = operations.filter(operation => operation.path === path);
  const candidates = staticRoutes.length > 0
    ? staticRoutes
    : [...new Set(operations.filter(operation => templateMatches(operation.path, path)).map(operation => operation.path))]
      .flatMap(route => operations.filter(operation => operation.path === route));
  if (staticRoutes.length === 0 && new Set(candidates.map(operation => operation.path)).size !== 1) return undefined;

  const matches = candidates.filter(operation => operation.method.toUpperCase() === method.toUpperCase());
  return matches.length === 1 ? matches[0] : undefined;
}

export function mcpWriteKind(
  method: string,
  path: string,
  operations: readonly DirectOperation[] = directOperations,
): McpWriteKind | undefined {
  if (method.toUpperCase() !== 'POST') return undefined;
  const operation = matchDirectOperation(method, path, operations);
  if (operation?.access === 'write' && Object.hasOwn(APPROVED_WRITE_KINDS, operation.operationId)) {
    const approvedKind = APPROVED_WRITE_KINDS[operation.operationId];
    return approvedKind;
  }

  // Legacy title updates are supported explicitly, not enabled by spec metadata.
  if (/^\/api\/threads\/[A-Za-z0-9][A-Za-z0-9_-]{0,511}\/title$/.test(path)) return 'title';
  return undefined;
}
