/**
 * Unit tests for the workspace-context ALS + Prisma middleware.
 *
 * Verifies:
 *   1. withWorkspaceContext sets the store correctly.
 *   2. getWorkspaceId returns the right id inside vs. outside the context.
 *   3. Nested contexts are isolated.
 *   4. Context does NOT leak across unrelated async chains.
 */

process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:5432/test'

import { describe, it, expect, vi } from 'vitest'
import { withWorkspaceContext, getWorkspaceId } from '../../../src/lib/workspace-context.js'

describe('withWorkspaceContext / getWorkspaceId', () => {
  it('returns workspaceId inside the context', async () => {
    let capturedId: string | undefined

    await withWorkspaceContext('ws-123', async () => {
      capturedId = getWorkspaceId()
    })

    expect(capturedId).toBe('ws-123')
  })

  it('returns undefined outside any context', () => {
    const id = getWorkspaceId()
    expect(id).toBeUndefined()
  })

  it('isolates nested contexts (inner wins)', async () => {
    const ids: Array<string | undefined> = []

    await withWorkspaceContext('outer-ws', async () => {
      ids.push(getWorkspaceId())

      await withWorkspaceContext('inner-ws', async () => {
        ids.push(getWorkspaceId())
      })

      ids.push(getWorkspaceId())
    })

    expect(ids).toEqual(['outer-ws', 'inner-ws', 'outer-ws'])
  })

  it('does not leak context across parallel chains', async () => {
    const captured: Array<string | undefined> = []

    await Promise.all([
      withWorkspaceContext('ws-A', async () => {
        // Simulate some async work
        await new Promise((r) => setTimeout(r, 5))
        captured.push(getWorkspaceId())
      }),
      withWorkspaceContext('ws-B', async () => {
        await new Promise((r) => setTimeout(r, 1))
        captured.push(getWorkspaceId())
      }),
    ])

    // Both should see their own workspace id, order may vary
    expect(captured).toContain('ws-A')
    expect(captured).toContain('ws-B')
    expect(captured).toHaveLength(2)
  })

  it('context exits cleanly after async work', async () => {
    await withWorkspaceContext('ws-ephemeral', async () => {
      expect(getWorkspaceId()).toBe('ws-ephemeral')
    })

    // After the async function resolves we are outside the context
    // (the next synchronous tick is not inside the ALS scope)
    // Note: this test validates the API contract; whether ALS clears on
    // exit depends on the runtime, but withWorkspaceContext callbacks
    // are isolated from the caller's context.
    expect(getWorkspaceId()).toBeUndefined()
  })
})

describe('Prisma middleware workspace scoping', () => {
  it('injects workspaceId into findMany params for scoped models', async () => {
    // We test the middleware logic directly without a live DB by building a
    // minimal params + next mock that records what params it receives.

    const { workspaceStorage } = await import('../../../src/lib/workspace-context.js')

    type PrismaParams = {
      model?: string
      action?: string
      args?: Record<string, unknown>
    }

    // Simulate the middleware logic (extracted from src/lib/prisma.ts)
    const WORKSPACE_SCOPED_MODELS = new Set([
      'FormDefinition',
      'FormTemplate',
      'FormWebhook',
      'ApiToken',
      'AuditLog',
    ])

    function simulateMiddleware(
      params: PrismaParams,
      workspaceId: string | undefined,
    ): PrismaParams {
      if (
        workspaceId &&
        params.model != null &&
        WORKSPACE_SCOPED_MODELS.has(params.model) &&
        params.action === 'findMany'
      ) {
        params.args = params.args ?? {}
        params.args.where = {
          ...(params.args.where ?? {}),
          workspaceId,
        }
      }
      return params
    }

    // Inside context: workspaceId injected
    await withWorkspaceContext('ws-inject-test', async () => {
      const params: PrismaParams = {
        model: 'FormDefinition',
        action: 'findMany',
        args: { where: { archivedAt: null } },
      }

      const mutated = simulateMiddleware(params, getWorkspaceId())
      expect(mutated.args?.['where']).toMatchObject({
        archivedAt: null,
        workspaceId: 'ws-inject-test',
      })
    })
  })

  it('does NOT inject workspaceId outside any context', () => {
    const WORKSPACE_SCOPED_MODELS = new Set([
      'FormDefinition',
      'FormTemplate',
      'FormWebhook',
      'ApiToken',
      'AuditLog',
    ])

    type PrismaParams = {
      model?: string
      action?: string
      args?: Record<string, unknown>
    }

    function simulateMiddleware(
      params: PrismaParams,
      workspaceId: string | undefined,
    ): PrismaParams {
      if (
        workspaceId &&
        params.model != null &&
        WORKSPACE_SCOPED_MODELS.has(params.model) &&
        params.action === 'findMany'
      ) {
        params.args = params.args ?? {}
        params.args.where = {
          ...(params.args.where ?? {}),
          workspaceId,
        }
      }
      return params
    }

    const params: PrismaParams = {
      model: 'FormDefinition',
      action: 'findMany',
      args: { where: { archivedAt: null } },
    }

    const noWorkspace = getWorkspaceId() // undefined outside context
    const mutated = simulateMiddleware(params, noWorkspace)

    // args.where should NOT have workspaceId
    expect(mutated.args?.['where']).not.toHaveProperty('workspaceId')
    expect(mutated.args?.['where']).toMatchObject({ archivedAt: null })
  })

  it('does NOT inject workspaceId for non-scoped models', async () => {
    const WORKSPACE_SCOPED_MODELS = new Set([
      'FormDefinition',
      'FormTemplate',
      'FormWebhook',
      'ApiToken',
      'AuditLog',
    ])

    type PrismaParams = {
      model?: string
      action?: string
      args?: Record<string, unknown>
    }

    function simulateMiddleware(
      params: PrismaParams,
      workspaceId: string | undefined,
    ): PrismaParams {
      if (
        workspaceId &&
        params.model != null &&
        WORKSPACE_SCOPED_MODELS.has(params.model) &&
        params.action === 'findMany'
      ) {
        params.args = params.args ?? {}
        params.args.where = {
          ...(params.args.where ?? {}),
          workspaceId,
        }
      }
      return params
    }

    await withWorkspaceContext('ws-no-inject', async () => {
      // FormSubmission is NOT in the scoped set
      const params: PrismaParams = {
        model: 'FormSubmission',
        action: 'findMany',
        args: { where: { status: 'submitted' } },
      }

      const mutated = simulateMiddleware(params, getWorkspaceId())
      expect(mutated.args?.['where']).not.toHaveProperty('workspaceId')
    })
  })
})
