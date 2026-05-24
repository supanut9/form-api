/**
 * Deterministic A/B variant assignment.
 *
 * Algorithm:
 *   sha256(experimentId + ':' + anonymousToken)
 *   → first 4 bytes as big-endian uint32
 *   → modulo 10_000 (maps into basis-point space)
 *   → walk variants in order by cumulative weightBps until the bucket is covered
 *
 * This function is pure — no DB, no side effects. The caller (ExperimentService)
 * persists the result and guarantees stickiness via the unique index on
 * (experiment_id, anonymous_token) in form_experiment_exposures.
 */

import { createHash } from 'node:crypto'

export interface VariantWeight {
  id: string
  weightBps: number // basis points; all variants in an experiment must sum to 10_000
}

/**
 * Assigns a variant deterministically for a given (experimentId, anonymousToken) pair.
 *
 * @param experimentId  UUID of the experiment.
 * @param variants      Array of { id, weightBps }. Must be non-empty; weights must sum to 10_000.
 * @param anonymousToken  Stable visitor identifier (UUID cookie).
 * @returns The assigned variant's id.
 * @throws Error if variants is empty.
 */
export function assignVariant(
  experimentId: string,
  variants: VariantWeight[],
  anonymousToken: string,
): string {
  if (variants.length === 0) {
    throw new Error('assignVariant: variants array must be non-empty')
  }

  // Deterministic hash: sha256(experimentId:anonymousToken)
  const digest = createHash('sha256')
    .update(`${experimentId}:${anonymousToken}`)
    .digest()

  // First 4 bytes → unsigned 32-bit big-endian integer
  const uint32 = digest.readUInt32BE(0)

  // Map into basis-point bucket [0, 10_000)
  const bucket = uint32 % 10_000

  // Walk cumulative weights to find the assigned variant
  let cumulative = 0
  for (const variant of variants) {
    cumulative += variant.weightBps
    if (bucket < cumulative) {
      return variant.id
    }
  }

  // Fallback: return last variant (guards against floating-point edge cases with
  // weights that don't sum exactly to 10_000 due to rounding; the service validates
  // the sum before calling this function, so this path should never be reached).
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return variants[variants.length - 1]!.id
}
