import { type CSSProperties, type FormEvent, useState } from 'react'
import type { WidgetRenderProps } from './types'
import type { FormData, FormField } from './form'

/** kbz.form renderer — a bounded form from sanitizeForm's flattened fields. Submit emits {t:'submit', values}
 *  via onEvent (rides `wevt` to peers + the posting agent). Required fields are validated locally first. */
export default function FormWidget({ data, fill, onEvent }: WidgetRenderProps<FormData>) {
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const [sent, setSent] = useState(false)
  const set = (name: string, v: string | boolean) => setValues((p) => ({ ...p, [name]: v }))

  const missing = data.fields.filter((f) => f.required && !truthy(values[f.name]))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (missing.length || sent) return
    onEvent?.({ t: 'submit', values })
    setSent(true)
  }

  if (sent)
    return (
      <div style={{ ...card, maxWidth: fill ? '100%' : 'min(360px, 100%)' }}>
        <div style={done}>✓ Submitted{data.title ? ` — ${data.title}` : ''}</div>
      </div>
    )

  return (
    <form style={{ ...card, maxWidth: fill ? '100%' : 'min(360px, 100%)' }} onSubmit={submit}>
      {data.title && <div style={title}>{data.title}</div>}
      {data.description && <div style={desc}>{data.description}</div>}
      {data.fields.map((f) => (
        <label key={f.name} style={fieldWrap}>
          <span style={lbl}>
            {f.label}
            {f.required && <span style={req}> *</span>}
          </span>
          {renderField(f, values[f.name], (v) => set(f.name, v))}
          {f.description && <span style={hint}>{f.description}</span>}
        </label>
      ))}
      <button type="submit" disabled={!!missing.length} style={{ ...btn, opacity: missing.length ? 0.5 : 1 }}>
        {data.submitLabel}
      </button>
    </form>
  )
}

const truthy = (v: unknown) => (typeof v === 'boolean' ? v : typeof v === 'string' ? v.trim().length > 0 : v != null)

function renderField(f: FormField, value: string | boolean | undefined, onChange: (v: string | boolean) => void) {
  if (f.type === 'checkbox') return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} style={check} />
  if (f.type === 'textarea') return <textarea value={String(value ?? '')} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} rows={3} style={input} />
  if (f.type === 'select')
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={input}>
        <option value="">{f.placeholder || 'Choose…'}</option>
        {(f.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  return <input type={f.type === 'number' ? 'number' : 'text'} value={String(value ?? '')} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} style={input} />
}

const card: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, background: '#fff', color: '#1a1a1a', borderRadius: 12, padding: 16, width: '100%', boxShadow: '0 1px 4px rgba(0,0,0,.25)' }
const title: CSSProperties = { font: '800 16px/1.3 system-ui, sans-serif' }
const desc: CSSProperties = { font: '400 13px/1.5 system-ui, sans-serif', color: '#4a5568', marginTop: -4 }
const fieldWrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 }
const lbl: CSSProperties = { font: '600 13px/1.3 system-ui, sans-serif' }
const req: CSSProperties = { color: '#e03131' }
const hint: CSSProperties = { font: '400 11.5px/1.4 system-ui, sans-serif', color: '#7a8699' }
const input: CSSProperties = { font: '400 14px/1.4 system-ui, sans-serif', padding: '9px 11px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#1a1a1a', width: '100%', boxSizing: 'border-box' }
const check: CSSProperties = { width: 20, height: 20, accentColor: '#2563eb' }
const btn: CSSProperties = { font: '700 14px/1 system-ui, sans-serif', padding: '11px 16px', borderRadius: 9, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', marginTop: 2 }
const done: CSSProperties = { font: '700 15px/1.4 system-ui, sans-serif', color: '#1a7f37', textAlign: 'center', padding: '8px 0' }
