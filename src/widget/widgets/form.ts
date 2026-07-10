// kbz.form — an interactive form from a JSON Schema (+ optional UI schema). We flatten the schema to a small,
// bounded list of fields at sanitize time so the renderer stays trivial + safe (no arbitrary schema execution).
// Submitting emits {t:'submit', values} on the `wevt` channel → peers + (when wired) the posting agent.

export type FieldType = 'text' | 'textarea' | 'number' | 'checkbox' | 'select'
export interface FormField {
  name: string
  type: FieldType
  label: string
  required: boolean
  options?: string[] // for select
  placeholder?: string
  description?: string
}
export interface FormData {
  title?: string
  description?: string
  fields: FormField[]
  submitLabel: string
}

const MAX_FIELDS = 24
const s = (v: unknown, n: number): string | undefined => (typeof v === 'string' && v.trim() ? v.slice(0, n) : undefined)

/** Map one JSON-Schema property (+ its uiSchema hint) to a bounded field. */
function toField(name: string, prop: Record<string, unknown>, ui: Record<string, unknown>, required: boolean): FormField | null {
  if (!name) return null
  const label = s(prop.title, 80) || name
  const widget = s(ui.widget, 20) || s(ui['ui:widget'], 20)
  const enumVals = Array.isArray(prop.enum) ? prop.enum.filter((e) => typeof e === 'string' || typeof e === 'number').map((e) => String(e).slice(0, 80)).slice(0, 30) : null
  let type: FieldType = 'text'
  if (prop.type === 'boolean') type = 'checkbox'
  else if (prop.type === 'number' || prop.type === 'integer') type = 'number'
  else if (enumVals && enumVals.length) type = 'select'
  else if (widget === 'textarea') type = 'textarea'
  return {
    name: name.slice(0, 60),
    type,
    label,
    required,
    options: type === 'select' ? enumVals || [] : undefined,
    placeholder: s(ui.placeholder, 80) || s(ui['ui:placeholder'], 80),
    description: s(prop.description, 200),
  }
}

export function sanitizeForm(raw: unknown): FormData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  // Accept { schema, uiSchema?, ... } (JSON Schema) OR a pre-flattened { fields: [...] }.
  const schema = (d.schema && typeof d.schema === 'object' ? (d.schema as Record<string, unknown>) : d) as Record<string, unknown>
  const ui = (d.uiSchema && typeof d.uiSchema === 'object' ? (d.uiSchema as Record<string, unknown>) : {}) as Record<string, unknown>
  const props = schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, unknown>) : null
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : [])

  let fields: FormField[] = []
  if (props) {
    fields = Object.entries(props)
      .slice(0, MAX_FIELDS)
      .map(([name, prop]) => toField(name, (prop && typeof prop === 'object' ? prop : {}) as Record<string, unknown>, (ui[name] && typeof ui[name] === 'object' ? ui[name] : {}) as Record<string, unknown>, required.has(name)))
      .filter((f): f is FormField => !!f)
  } else if (Array.isArray(d.fields)) {
    // pre-flattened fields[] (defensive: still bound + coerce)
    fields = (d.fields as unknown[])
      .slice(0, MAX_FIELDS)
      .map((f) => (f && typeof f === 'object' ? toField(String((f as Record<string, unknown>).name ?? ''), f as Record<string, unknown>, f as Record<string, unknown>, !!(f as Record<string, unknown>).required) : null))
      .filter((f): f is FormField => !!f)
  }
  if (!fields.length) return null
  return {
    title: s(d.title, 200),
    description: s(d.description, 400),
    fields,
    submitLabel: s(d.submitLabel, 40) || 'Submit',
  }
}
