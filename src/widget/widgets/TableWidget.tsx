import type { CSSProperties } from 'react'
import type { WidgetRenderProps } from './types'
import type { TableData } from './table'

/** kbz.table renderer — a clean scrollable data table. Zero-dep; cells are plain text (React escapes them). */
export default function TableWidget({ data, fill }: WidgetRenderProps<TableData>) {
  return (
    <div style={{ ...wrap, maxWidth: fill ? '100%' : 'min(360px, 100%)', maxHeight: fill ? '100%' : 300 }}>
      {data.title && <div style={title}>{data.title}</div>}
      <div style={scroll}>
        <table style={table}>
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c.key} style={th}>
                  {c.label || c.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={i} style={i % 2 ? rowAlt : undefined}>
                {data.columns.map((c) => (
                  <td key={c.key} style={td}>
                    {fmt(r[c.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const fmt = (v: unknown): string => (v == null ? '' : typeof v === 'boolean' ? (v ? '✓' : '—') : String(v))

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0 }
const title: CSSProperties = { font: '700 13px/1.3 system-ui, sans-serif', margin: '0 0 6px', color: 'var(--kw-fg, #fff)' }
const scroll: CSSProperties = { overflow: 'auto', minWidth: 0, borderRadius: 10, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.25)' }
const table: CSSProperties = { borderCollapse: 'collapse', width: '100%', font: '400 12px/1.4 system-ui, sans-serif', color: '#1a1a1a' }
const th: CSSProperties = { textAlign: 'left', padding: '8px 10px', background: '#f1f4f9', fontWeight: 700, position: 'sticky', top: 0, whiteSpace: 'nowrap', borderBottom: '1px solid #e3e8f0' }
const td: CSSProperties = { padding: '7px 10px', borderBottom: '1px solid #eef1f6', verticalAlign: 'top' }
const rowAlt: CSSProperties = { background: '#fafbfd' }
