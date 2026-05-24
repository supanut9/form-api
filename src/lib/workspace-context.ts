/**
 * AsyncLocalStorage-based workspace context for Prisma query scoping.
 *
 * Usage inside a route handler (or preHandler):
 *
 *   import { withWorkspaceContext } from '../lib/workspace-context.js'
 *
 *   await withWorkspaceContext(workspaceId, async () => {
 *     const forms = await prisma.formDefinition.findMany()
 *     // → automatically filtered to workspaceId
 *   })
 *
 * The Prisma middleware in src/lib/prisma.ts reads the store on every query.
 * Queries executed OUTSIDE withWorkspaceContext (e.g. pre-3C code paths) see
 * an empty store and are NOT filtered — preserving backward compatibility with
 * Phase 1 / 3A / 3B routes.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface WorkspaceContext {
  workspaceId: string
}

export const workspaceStorage = new AsyncLocalStorage<WorkspaceContext>()

/**
 * Runs `fn` inside a workspace-scoped async context.
 * All Prisma calls within `fn` (and any async work it spawns) will have the
 * workspace filter injected by the Prisma middleware.
 */
export function withWorkspaceContext<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return workspaceStorage.run({ workspaceId }, fn)
}

/**
 * Returns the active workspace id from the current async context, or undefined
 * if called outside withWorkspaceContext.
 */
export function getWorkspaceId(): string | undefined {
  return workspaceStorage.getStore()?.workspaceId
}
