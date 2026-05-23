/**
 * calc.runner.ts — server-side authoritative HyperFormula calculation gate.
 *
 * Field-id → A1 mapping algorithm (one sentence):
 *   Fields are collected in page-declaration order (page index ascending, then
 *   field index ascending within each page); each field's id maps to column A,
 *   row = declaration-order index (0-based), i.e. the Nth field in spec order
 *   maps to cell A(N+1) in spreadsheet notation.
 *
 * Each calc entry gets its own column so calc-to-calc references are possible:
 *   columns A…Z carry field values; calculations live in column B of a second
 *   virtual sheet named "Calcs", referencing Sheet1!A(N) for field values and
 *   Calcs!B(M) for calc-to-calc references.
 *
 *   Concrete layout:
 *     Sheet1  — one row per field, column A holds the submitted value
 *     Calcs   — one row per calc entry (declaration order), column A holds the
 *               compiled HF formula, result read back from column A
 *
 * The compiled map is memoized in an LRU keyed by `${formId}@${version}`.
 *
 * Lane L1 (renderer) must use the same `compileFieldMap` export so browser and
 * server stay in sync; the mapping is purely a function of `spec.pages` order.
 */

import { HyperFormula } from 'hyperformula'
import { LRUCache } from 'lru-cache'
import type { FormSpec } from '../forms/types.js'

// ── Types for Phase-3A spec extensions ───────────────────────────────────────
// L3 owns spec-3a.ts; we declare minimal ambient shapes here so this lane
// compiles without touching spec.validator.ts.

export interface CalcEntry {
  id: string
  label: string
  formula: string
  hidden?: boolean
}

export interface FormSpecWith3A extends FormSpec {
  calculations?: CalcEntry[]
}

// ── Field-map compilation ─────────────────────────────────────────────────────

/**
 * Compiles the field-id → A1 cell address map (Sheet1 only).
 *
 * Declaration order: pages in spec order, fields within each page in their
 * declared order.  The Nth field (0-indexed) maps to "A{N+1}".
 *
 * Both the server (`calc.runner.ts`) and Lane L1's renderer `calc.ts` must
 * import and use this exact function so the mapping is never duplicated.
 */
export function compileFieldMap(spec: FormSpec): Record<string, string> {
  const map: Record<string, string> = {}
  let row = 1 // spreadsheet rows are 1-based
  for (const page of spec.pages) {
    for (const field of page.fields) {
      map[field.id] = `A${row}`
      row++
    }
  }
  return map
}

// ── HF instance cache ─────────────────────────────────────────────────────────

interface HFEntry {
  hf: HyperFormula
  sheet1Id: number
  calcsSheetId: number
  fieldMap: Record<string, string>
  /** calc-id → zero-based row index in the Calcs sheet */
  calcRowMap: Record<string, number>
  fieldCount: number
}

const hfCache = new LRUCache<string, HFEntry>({
  max: 256,
})

function buildHFEntry(spec: FormSpecWith3A): HFEntry {
  const hf = HyperFormula.buildEmpty({ licenseKey: 'gpl-v3' })

  // Sheet1: one row per field, column A = value placeholder (0 for now)
  hf.addSheet('Sheet1')
  const sheet1Id = hf.getSheetId('Sheet1') as number
  const fieldMap = compileFieldMap(spec)
  const fieldCount = Object.keys(fieldMap).length

  if (fieldCount > 0) {
    // Pre-allocate rows so setCellContents works on existing coordinates.
    // HyperFormula auto-extends, but explicit preload avoids edge cases.
    const blankRows: number[][] = Array.from({ length: fieldCount }, () => [0])
    hf.setCellContents({ sheet: sheet1Id, row: 0, col: 0 }, blankRows)
  }

  // Calcs sheet: one row per calc entry, column A = formula referencing Sheet1
  hf.addSheet('Calcs')
  const calcsSheetId = hf.getSheetId('Calcs') as number
  const calcRowMap: Record<string, number> = {}
  const calcs = spec.calculations ?? []

  for (let i = 0; i < calcs.length; i++) {
    const calc = calcs[i]
    if (!calc) continue
    calcRowMap[calc.id] = i
    // Replace field-id tokens with their Sheet1 A1 addresses.
    // Replace calc-id tokens with their Calcs sheet row addresses.
    const compiled = compileFormula(calc.formula, fieldMap, calcRowMap)
    hf.setCellContents({ sheet: calcsSheetId, row: i, col: 0 }, [[compiled]])
  }

  return { hf, sheet1Id, calcsSheetId, fieldMap, calcRowMap, fieldCount }
}

/**
 * Translate a human-authored formula into a HyperFormula formula.
 *
 * Rules (applied in declaration order so earlier calc references work):
 *  1. Replace `fld_*` tokens with `Sheet1.A{row}` refs.
 *  2. Replace calc-id tokens already in `calcRowMap` with `Calcs.A{row+1}`.
 *  3. Prefix the result with `=` if not already present.
 */
function compileFormula(
  formula: string,
  fieldMap: Record<string, string>,
  calcRowMap: Record<string, number>,
): string {
  let f = formula.trim()

  // Replace field ids (longest first to avoid partial matches)
  const fieldIds = Object.keys(fieldMap).sort((a, b) => b.length - a.length)
  for (const id of fieldIds) {
    const addr = fieldMap[id]
    if (!addr) continue
    // Escape the id for use in a regex (dots, underscores are safe but be explicit)
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    f = f.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `Sheet1!${addr}`)
  }

  // Replace calc ids already compiled (same pass order as calcs array)
  const calcIds = Object.keys(calcRowMap).sort((a, b) => b.length - a.length)
  for (const id of calcIds) {
    const rowIdx = calcRowMap[id]
    if (rowIdx === undefined) continue
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    f = f.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `Calcs!A${rowIdx + 1}`)
  }

  if (!f.startsWith('=')) f = `=${f}`
  return f
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute all `calculations` entries for a given submission values map.
 *
 * @param spec     The published form spec (may include Phase-3A `calculations`).
 * @param values   The submitted field values keyed by field-id.
 * @param formId   Used as LRU cache key alongside `version`.
 * @param version  Used as LRU cache key alongside `formId`.
 * @returns        Map of calc-id → result (number | string | null).
 *                 null means HF returned an error or the formula was invalid.
 */
export function computeCalculationsServer(
  spec: FormSpecWith3A,
  values: Record<string, unknown>,
  formId: string = '__anon__',
  version: number = 0,
): Record<string, number | string | null> {
  const calcs = spec.calculations ?? []
  if (calcs.length === 0) return {}

  const cacheKey = `${formId}@${version}`
  let entry = hfCache.get(cacheKey)
  if (!entry) {
    entry = buildHFEntry(spec)
    hfCache.set(cacheKey, entry)
  }

  const { hf, sheet1Id, calcsSheetId, fieldMap, calcRowMap } = entry

  // Populate Sheet1 column A with submitted values (numeric coercion).
  for (const [fieldId, addr] of Object.entries(fieldMap)) {
    const raw = values[fieldId]
    const num = toHFValue(raw)
    const row = addrToRow(addr)
    hf.setCellContents({ sheet: sheet1Id, row, col: 0 }, [[num]])
  }

  // Read back calc results from the Calcs sheet.
  const results: Record<string, number | string | null> = {}
  for (const calc of calcs) {
    const row = calcRowMap[calc.id]
    if (row === undefined) {
      results[calc.id] = null
      continue
    }
    try {
      const raw = hf.getCellValue({ sheet: calcsSheetId, row, col: 0 })
      if (raw === null || raw === undefined) {
        results[calc.id] = null
      } else if (typeof raw === 'number' || typeof raw === 'string') {
        results[calc.id] = raw
      } else if (typeof raw === 'boolean') {
        results[calc.id] = raw ? 1 : 0
      } else if (
        raw !== null &&
        typeof raw === 'object' &&
        'type' in (raw as object)
      ) {
        // HyperFormula CellError object
        console.warn(`[calc.runner] formula error for calc ${calc.id}:`, raw)
        results[calc.id] = null
      } else {
        results[calc.id] = null
      }
    } catch (err) {
      console.warn(`[calc.runner] exception reading calc ${calc.id}:`, err)
      results[calc.id] = null
    }
  }

  return results
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert an arbitrary submitted value to a number HyperFormula can work with.
 * Arrays (multiselect) sum their numeric members; non-numeric strings → 0;
 * undefined/null → 0.
 */
function toHFValue(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'string') {
    const n = parseFloat(raw)
    return isFinite(n) ? n : 0
  }
  if (Array.isArray(raw)) {
    return raw.reduce<number>((acc, item) => {
      const n = typeof item === 'number' && isFinite(item) ? item : 0
      return acc + n
    }, 0)
  }
  return 0
}

/** Convert "A1" → 0-based row index (0). */
function addrToRow(addr: string): number {
  const n = parseInt(addr.slice(1), 10)
  return isNaN(n) ? 0 : n - 1
}
