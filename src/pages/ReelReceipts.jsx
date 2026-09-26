import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { rowsToCsv, downloadCsv, addMonths, todayStr } from '../lib/csv'

const emptyForm = {
  reel_number: '',
  quality: '',
  gsm: '',
  size_cm: '',
  gross_weight: '',
  kanta_weight: '',
  net_weight: '',
  cutting_name: '',
  date: todayStr(),
  remarks: '',
}

function round2(n) {
  return Math.round(n * 100) / 100
}

const REPORT_COLUMNS = [
  { label: 'Reel Number', value: (r) => r.reel_number },
  { label: 'Quality', value: (r) => r.quality },
  { label: 'GSM', value: (r) => r.gsm },
  { label: 'Size (cm)', value: (r) => r.size_cm },
  { label: 'Size (in)', value: (r) => r.size_in },
  { label: 'Gross Weight', value: (r) => r.gross_weight },
  { label: 'Kanta Weight', value: (r) => r.kanta_weight },
  { label: 'Net Weight', value: (r) => r.net_weight },
  { label: 'Cutting / Location', value: (r) => r.cutting_name },
  { label: 'Date', value: (r) => r.date },
  { label: 'Remarks', value: (r) => r.remarks },
  { label: 'Edited By', value: (r) => r.profiles?.name },
]

export default function ReelReceipts() {
  const { user } = useAuth()
  const [recent, setRecent] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [reportFrom, setReportFrom] = useState(todayStr())
  const [reportTo, setReportTo] = useState(todayStr())
  const [reportError, setReportError] = useState(null)
  const [reportBusy, setReportBusy] = useState(false)

  const sizeIn = useMemo(() => {
    const cm = Number(form.size_cm)
    return form.size_cm && !Number.isNaN(cm) ? round2(cm / 2.54) : null
  }, [form.size_cm])

  useEffect(() => {
    loadRecent()
  }, [])

  async function loadRecent() {
    const { data, error } = await supabase
      .from('reel_receipts')
      .select('reel_id, reel_number, quality, gsm, size_cm, size_in, gross_weight, kanta_weight, net_weight, cutting_name, date, remarks, profiles(name)')
      .order('reel_id', { ascending: false })
      .limit(25)
    if (error) setError(error.message)
    else setRecent(data)
  }

  function updateField(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function startEdit(r) {
    setEditingId(r.reel_id)
    setForm({
      reel_number: r.reel_number,
      quality: r.quality,
      gsm: r.gsm != null ? String(r.gsm) : '',
      size_cm: String(r.size_cm),
      gross_weight: String(r.gross_weight),
      kanta_weight: String(r.kanta_weight),
      net_weight: r.net_weight != null ? String(r.net_weight) : '',
      cutting_name: r.cutting_name || '',
      date: r.date,
      remarks: r.remarks || '',
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setForm(emptyForm)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const payload = {
      reel_number: form.reel_number.trim(),
      quality: form.quality.trim(),
      gsm: form.gsm ? Number(form.gsm) : null,
      size_cm: Number(form.size_cm),
      size_in: sizeIn,
      gross_weight: Number(form.gross_weight),
      kanta_weight: Number(form.kanta_weight),
      net_weight: form.net_weight ? Number(form.net_weight) : null,
      cutting_name: form.cutting_name || null,
      date: form.date,
      remarks: form.remarks || null,
      edited_by: user.id,
    }
    const { error } = editingId
      ? await supabase.from('reel_receipts').update(payload).eq('reel_id', editingId)
      : await supabase.from('reel_receipts').insert(payload)
    setSubmitting(false)
    if (error) {
      setError(
        error.code === '23505'
          ? `Reel number "${payload.reel_number}" already exists — check for a typo or duplicate entry.`
          : error.message
      )
      return
    }
    setEditingId(null)
    setForm({ ...emptyForm, date: form.date })
    loadRecent()
  }

  async function handleDownloadReport(e) {
    e.preventDefault()
    setReportError(null)

    if (!reportFrom || !reportTo) {
      setReportError('Pick both a from and to date.')
      return
    }
    if (reportTo < reportFrom) {
      setReportError('To date must be on or after the from date.')
      return
    }
    if (reportTo > addMonths(reportFrom, 2)) {
      setReportError('Date range cannot exceed 2 months.')
      return
    }

    setReportBusy(true)
    const { data, error } = await supabase
      .from('reel_receipts')
      .select('reel_number, quality, gsm, size_cm, size_in, gross_weight, kanta_weight, net_weight, cutting_name, date, remarks, profiles(name)')
      .gte('date', reportFrom)
      .lte('date', reportTo)
      .order('date', { ascending: true })
      .order('reel_id', { ascending: true })
    setReportBusy(false)

    if (error) {
      setReportError(error.message)
      return
    }
    downloadCsv(`reel-receipts-${reportFrom}-to-${reportTo}.csv`, rowsToCsv(data, REPORT_COLUMNS))
  }

  return (
    <div className="page">
      <h1>Reel Receipts (incoming reel stock)</h1>

      <form className="stack-form" onSubmit={handleSubmit}>
        <label>
          Reel Number
          <input value={form.reel_number} onChange={(e) => updateField('reel_number', e.target.value)} required />
        </label>
        <label>
          Quality
          <input value={form.quality} onChange={(e) => updateField('quality', e.target.value)} required />
        </label>
        <label>
          GSM
          <input type="number" min="0" step="any" value={form.gsm} onChange={(e) => updateField('gsm', e.target.value)} />
        </label>
        <label>
          Size (cm)
          <input type="number" min="0.01" step="any" value={form.size_cm} onChange={(e) => updateField('size_cm', e.target.value)} required />
        </label>
        <label>
          Size (in)
          <input value={sizeIn ?? ''} disabled />
        </label>
        <label>
          Gross Weight (kg)
          <input type="number" min="0.01" step="any" value={form.gross_weight} onChange={(e) => updateField('gross_weight', e.target.value)} required />
        </label>
        <label>
          Kanta Weight (kg)
          <input type="number" min="0.01" step="any" value={form.kanta_weight} onChange={(e) => updateField('kanta_weight', e.target.value)} required />
        </label>
        <label>
          Net Weight (kg)
          <input type="number" min="0.01" step="any" value={form.net_weight} onChange={(e) => updateField('net_weight', e.target.value)} required />
        </label>
        <label>
          Cutting / Location
          <input value={form.cutting_name} onChange={(e) => updateField('cutting_name', e.target.value)} />
        </label>
        <label>
          Date
          <input type="date" value={form.date} onChange={(e) => updateField('date', e.target.value)} required />
        </label>
        <label>
          Remarks
          <input value={form.remarks} onChange={(e) => updateField('remarks', e.target.value)} />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : editingId ? 'Update receipt' : 'Record reel receipt'}
        </button>
        {editingId && <button type="button" onClick={cancelEdit}>Cancel</button>}
      </form>

      {error && <p className="error">{error}</p>}

      <h2>Download report</h2>
      <form className="inline-form" onSubmit={handleDownloadReport}>
        <label>
          From
          <input type="date" value={reportFrom} max={reportTo} onChange={(e) => setReportFrom(e.target.value)} required />
        </label>
        <label>
          To
          <input type="date" value={reportTo} min={reportFrom} max={addMonths(reportFrom, 2)} onChange={(e) => setReportTo(e.target.value)} required />
        </label>
        <button type="submit" disabled={reportBusy}>{reportBusy ? 'Preparing…' : 'Download CSV'}</button>
      </form>
      {reportError && <p className="error">{reportError}</p>}
      <p className="hint">Date range is limited to 2 months.</p>

      <h2>Recent reel receipts</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Reel Number</th><th>Quality</th><th>GSM</th><th>Size (cm)</th><th>Size (in)</th><th>Gross Wt</th><th>Kanta Wt</th><th>Net Wt</th><th>Cutting/Location</th><th>Date</th><th>Remarks</th><th>Edited By</th><th></th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.reel_id}>
                <td>{r.reel_number}</td>
                <td>{r.quality}</td>
                <td>{r.gsm}</td>
                <td>{r.size_cm}</td>
                <td>{r.size_in}</td>
                <td>{r.gross_weight}</td>
                <td>{r.kanta_weight}</td>
                <td>{r.net_weight}</td>
                <td>{r.cutting_name}</td>
                <td>{r.date}</td>
                <td>{r.remarks}</td>
                <td>{r.profiles?.name}</td>
                <td><button type="button" onClick={() => startEdit(r)}>Edit</button></td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr><td colSpan={13}>No reel receipts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
