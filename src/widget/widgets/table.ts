// kbz.table — a simple data table. Schema: { title?, columns?, rows[] } OR a bare array of record objects
// (schema.org ItemList-ish). Cells are coerced to string/number/bool; everything is capped + escaped at render.
import type { WidgetExport } from './types'

export interface TableColumn {
  key: string
  label?: string
}
export interface TableData {
  title?: string
  columns: TableColumn[]
  rows: Record<string, string | number | boolean | null>[]
}

const MAX_ROWS = 200
const MAX_COLS = 16
const str = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, n) : undefined)

/** Coerce a cell to a renderable scalar (string/number/bool/null) — never an object/array. */
const cell = (v: unknown): string | number | boolean | null => {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.slice(0, 500)
  return String(v).slice(0, 200)
}

export function sanitizeTable(raw: unknown): TableData | null {
  const d = (Array.isArray(raw) ? { rows: raw } : raw) as Record<string, unknown> | null
  if (!d || typeof d !== 'object') return null
  const rawRows = Array.isArray(d.rows) ? d.rows : null
  if (!rawRows || !rawRows.length) return null
  const rows = rawRows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
    .slice(0, MAX_ROWS)
    .map((r) => {
      const out: Record<string, string | number | boolean | null> = {}
      for (const k of Object.keys(r).slice(0, MAX_COLS)) out[String(k).slice(0, 60)] = cell(r[k])
      return out
    })
  if (!rows.length) return null
  // Columns: explicit, else the union of keys (first row order, capped).
  let columns: TableColumn[]
  if (Array.isArray(d.columns) && d.columns.length) {
    columns = d.columns
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ key: String(c.key ?? '').slice(0, 60), label: str(c.label, 80) }))
      .filter((c) => c.key)
      .slice(0, MAX_COLS)
  } else {
    const seen = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r)) seen.add(k)
    columns = [...seen].slice(0, MAX_COLS).map((key) => ({ key }))
  }
  if (!columns.length) return null
  return { title: str(d.title, 200), columns, rows }
}

/** RFC-4180 cell: wrap in quotes (doubling internal quotes) when it holds a comma, quote, or newline. */
function csvCell(v: string | number | boolean | null): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** kbz.table → a UTF-8 CSV — header from the column labels, then each row in column order. A leading BOM so
 *  Excel reads UTF-8 correctly. The table AS ITSELF: openable in any spreadsheet. */
export function exportTableCsv(data: TableData): Promise<WidgetExport> {
  const header = data.columns.map((c) => csvCell(c.label ?? c.key)).join(',')
  const body = data.rows.map((r) => data.columns.map((c) => csvCell(r[c.key] ?? null)).join(','))
  const csv = [header, ...body].join('\r\n') + '\r\n'
  return Promise.resolve({ blob: new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }), base: data.title || 'table', ext: 'csv' })
}
