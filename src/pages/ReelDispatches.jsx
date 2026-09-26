import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { rowsToCsv, downloadCsv, addMonths, todayStr } from '../lib/csv'
import SearchableSelect from '../components/SearchableSelect'

const emptyForm = {
  reel_number: '',
  date: todayStr(),
  dispatch_type: 'full',
  sold_form: 'reel',
  remaining_size_cm: '',
  cutting_name: '',
  job_card_number: '',
  sold_to: '',
  kanta_weight: '',
  remarks: '',
}

const emptyCutItem = { cut_size_cm: '', weight_kg: '', bundle_count: '', sheets_per_bundle: '', extra_sheets: '', sold_to: '', remarks: '' }

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// e.g. 10 bundles x 100 sheets + 80 loose sheets = 1080 total
function totalSheets(bundleCount, sheetsPerBundle, extraSheets) {
  if (bundleCount == null && sheetsPerBundle == null && extraSheets == null) return null
  return (Number(bundleCount) || 0) * (Number(sheetsPerBundle) || 0) + (Number(extraSheets) || 0)
}

function cutReportRows(dispatches) {
  const rows = []
  for (const d of dispatches) {
    if (d.sold_form === 'cutting') {
      for (const c of d.reel_dispatch_cuts ?? []) {
        rows.push({
          reel_number: d.reel_number,
          quality: d.reel_receipts?.quality,
          date: d.date,
          dispatch_type: d.dispatch_type,
          sold_form: d.sold_form,
          remaining_size_cm: d.remaining_size_cm,
          remaining_gross_weight: d.remaining_gross_weight,
          remaining_kanta_weight: d.remaining_kanta_weight,
          remaining_net_weight: d.remaining_net_weight,
          cut_size_cm: c.cut_size_cm,
          bundle_count: c.bundle_count,
          sheets_per_bundle: c.sheets_per_bundle,
          extra_sheets: c.extra_sheets,
          total_sheets: totalSheets(c.bundle_count, c.sheets_per_bundle, c.extra_sheets),
          sold_to: c.sold_to,
          weight_kg: c.weight_kg,
          cutting_name: d.cutting_name,
          job_card_number: d.job_card_number,
          remarks: c.remarks || d.remarks,
          edited_by_name: d.profiles?.name,
          material_diff: d.reel_dispatch_status?.material_diff,
        })
      }
    } else {
      rows.push({
        reel_number: d.reel_number,
        quality: d.reel_receipts?.quality,
        date: d.date,
        dispatch_type: d.dispatch_type,
        sold_form: d.sold_form,
        remaining_size_cm: d.remaining_size_cm,
        remaining_gross_weight: d.remaining_gross_weight,
        remaining_kanta_weight: d.remaining_kanta_weight,
        remaining_net_weight: d.remaining_net_weight,
        cut_size_cm: null,
        bundle_count: null,
        sheets_per_bundle: null,
        extra_sheets: null,
        total_sheets: null,
        sold_to: d.sold_to,
        weight_kg: d.kanta_weight,
        cutting_name: d.cutting_name,
        job_card_number: d.job_card_number,
        remarks: d.remarks,
        edited_by_name: d.profiles?.name,
        material_diff: d.reel_dispatch_status?.material_diff,
      })
    }
  }
  return rows
}

const REPORT_COLUMNS = [
  { label: 'Reel Number', value: (r) => r.reel_number },
  { label: 'Quality', value: (r) => r.quality },
  { label: 'Date', value: (r) => r.date },
  { label: 'Type', value: (r) => r.dispatch_type },
  { label: 'Sold As', value: (r) => (r.sold_form === 'cutting' ? 'Cut into sheets' : 'Reel') },
  { label: 'Cut Size (cm)', value: (r) => r.cut_size_cm },
  { label: 'Bundles', value: (r) => r.bundle_count },
  { label: 'Sheets/Bundle', value: (r) => r.sheets_per_bundle },
  { label: 'Extra Sheets', value: (r) => r.extra_sheets },
  { label: 'Total Sheets', value: (r) => r.total_sheets },
  { label: 'Remaining Size (cm)', value: (r) => r.remaining_size_cm },
  { label: 'Remaining Gross Weight', value: (r) => r.remaining_gross_weight },
  { label: 'Remaining Kanta Weight', value: (r) => r.remaining_kanta_weight },
  { label: 'Remaining Net Weight', value: (r) => r.remaining_net_weight },
  { label: 'Sold To', value: (r) => r.sold_to },
  { label: 'Kanta Weight (kg)', value: (r) => r.weight_kg },
  { label: 'Cutting / Location', value: (r) => r.cutting_name },
  { label: 'Job Card Number', value: (r) => r.job_card_number },
  { label: 'Material +/- (kg)', value: (r) => r.material_diff },
  { label: 'Remarks', value: (r) => r.remarks },
  { label: 'Edited By', value: (r) => r.edited_by_name },
]

const DISPATCH_SELECT =
  'reel_dispatch_id, reel_number, date, dispatch_type, sold_form, remaining_size_cm, remaining_gross_weight, remaining_kanta_weight, remaining_net_weight, cutting_name, job_card_number, sold_to, kanta_weight, remarks, reel_receipts(quality, gsm), profiles(name), reel_dispatch_cuts(cut_id, cut_size_cm, weight_kg, bundle_count, sheets_per_bundle, extra_sheets, sold_to, remarks)'

export default function ReelDispatches() {
  const { user } = useAuth()
  const [reelStock, setReelStock] = useState([])
  const [recent, setRecent] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [cutItems, setCutItems] = useState([{ ...emptyCutItem }])
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [editingDispatchId, setEditingDispatchId] = useState(null)
  const [editingReelNumber, setEditingReelNumber] = useState(null)
  const [editingBaseline, setEditingBaseline] = useState(null)
  const [reportFrom, setReportFrom] = useState(todayStr())
  const [reportTo, setReportTo] = useState(todayStr())
  const [reportError, setReportError] = useState(null)
  const [reportBusy, setReportBusy] = useState(false)

  const reelOptions = useMemo(
    () => reelStock.map((r) => ({
      value: r.reel_number,
      label: `${r.reel_number} — ${r.quality} (${r.size_cm} cm, ${r.gross_weight} kg)${r.cutting_name ? ` @ ${r.cutting_name}` : ''}`,
    })),
    [reelStock]
  )

  const baseline = useMemo(() => {
    if (editingDispatchId) return editingBaseline
    return reelStock.find((r) => r.reel_number === form.reel_number) || null
  }, [editingDispatchId, editingBaseline, reelStock, form.reel_number])

  const preview = useMemo(() => {
    if (!baseline || form.dispatch_type !== 'partial') return null
    const remSize = Number(form.remaining_size_cm)
    if (!form.remaining_size_cm || Number.isNaN(remSize) || remSize < 0 || remSize >= baseline.size_cm) return null
    const remGross = round3((baseline.gross_weight * remSize) / baseline.size_cm)
    const remKanta = round3((baseline.kanta_weight * remSize) / baseline.size_cm)
    const remNet = baseline.net_weight != null ? round3((baseline.net_weight * remSize) / baseline.size_cm) : null
    return {
      remGross,
      remKanta,
      remNet,
      dispatchedApproxWeight: round3(baseline.gross_weight - remGross),
    }
  }, [baseline, form.dispatch_type, form.remaining_size_cm])

  const cutItemsTotal = useMemo(
    () => cutItems.reduce((sum, r) => sum + (Number(r.weight_kg) || 0), 0),
    [cutItems]
  )

  useEffect(() => {
    loadReelStock()
    loadRecent()
  }, [])

  async function loadReelStock() {
    const { data, error } = await supabase.from('reel_stock').select('*').order('reel_number')
    if (error) setError(error.message)
    else setReelStock(data ?? [])
  }

  async function attachDispatchStatus(dispatches) {
    if (dispatches.length === 0) return dispatches
    const ids = dispatches.map((d) => d.reel_dispatch_id)
    const { data, error } = await supabase
      .from('reel_dispatch_status')
      .select('reel_dispatch_id, material_diff')
      .in('reel_dispatch_id', ids)
    if (error) {
      setError(error.message)
      return dispatches
    }
    const statusById = new Map(data.map((s) => [s.reel_dispatch_id, s]))
    return dispatches.map((d) => ({ ...d, reel_dispatch_status: statusById.get(d.reel_dispatch_id) }))
  }

  async function loadRecent() {
    const { data, error } = await supabase
      .from('reel_dispatches')
      .select(DISPATCH_SELECT)
      .order('reel_dispatch_id', { ascending: false })
      .limit(25)
    if (error) {
      setError(error.message)
      return
    }
    setRecent(await attachDispatchStatus(data))
  }

  function updateField(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
  }

  function updateCutItem(index, field, value) {
    setCutItems((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  function addCutItem() {
    setCutItems((rows) => [...rows, { ...emptyCutItem }])
  }

  function removeCutItem(index) {
    setCutItems((rows) => rows.filter((_, i) => i !== index))
  }

  function cancelEdit() {
    setEditingDispatchId(null)
    setEditingReelNumber(null)
    setEditingBaseline(null)
    setForm(emptyForm)
    setCutItems([{ ...emptyCutItem }])
  }

  async function startEdit(d) {
    setError(null)
    const { data: newer, error: newerError } = await supabase
      .from('reel_dispatches')
      .select('reel_dispatch_id')
      .eq('reel_number', d.reel_number)
      .gt('reel_dispatch_id', d.reel_dispatch_id)
      .limit(1)
    if (newerError) {
      setError(newerError.message)
      return
    }
    if (newer.length > 0) {
      setError('Only the most recent dispatch for a reel can be edited — a later dispatch already happened against it.')
      return
    }

    const { data: prior, error: priorError } = await supabase
      .from('reel_dispatches')
      .select('remaining_size_cm, remaining_gross_weight, remaining_kanta_weight, remaining_net_weight, cutting_name')
      .eq('reel_number', d.reel_number)
      .lt('reel_dispatch_id', d.reel_dispatch_id)
      .order('reel_dispatch_id', { ascending: false })
      .limit(1)
    if (priorError) {
      setError(priorError.message)
      return
    }

    let base
    if (prior.length > 0) {
      base = {
        size_cm: prior[0].remaining_size_cm,
        gross_weight: prior[0].remaining_gross_weight,
        kanta_weight: prior[0].remaining_kanta_weight,
        net_weight: prior[0].remaining_net_weight,
        cutting_name: prior[0].cutting_name,
      }
    } else {
      const { data: receipt, error: receiptError } = await supabase
        .from('reel_receipts')
        .select('size_cm, gross_weight, kanta_weight, net_weight, cutting_name')
        .eq('reel_number', d.reel_number)
        .single()
      if (receiptError) {
        setError(receiptError.message)
        return
      }
      base = receipt
    }

    setEditingDispatchId(d.reel_dispatch_id)
    setEditingReelNumber(d.reel_number)
    setEditingBaseline(base)
    setForm({
      reel_number: d.reel_number,
      date: d.date,
      dispatch_type: d.dispatch_type,
      sold_form: d.sold_form,
      remaining_size_cm: d.remaining_size_cm != null ? String(d.remaining_size_cm) : '',
      cutting_name: d.cutting_name || '',
      job_card_number: d.job_card_number || '',
      sold_to: d.sold_to || '',
      kanta_weight: d.kanta_weight != null ? String(d.kanta_weight) : '',
      remarks: d.remarks || '',
    })
    setCutItems(
      d.sold_form === 'cutting' && d.reel_dispatch_cuts?.length
        ? d.reel_dispatch_cuts.map((c) => ({
            cut_size_cm: c.cut_size_cm,
            weight_kg: String(c.weight_kg),
            bundle_count: c.bundle_count != null ? String(c.bundle_count) : '',
            sheets_per_bundle: c.sheets_per_bundle != null ? String(c.sheets_per_bundle) : '',
            extra_sheets: c.extra_sheets != null ? String(c.extra_sheets) : '',
            sold_to: c.sold_to,
            remarks: c.remarks || '',
          }))
        : [{ ...emptyCutItem }]
    )
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!baseline) {
      setError('Pick a reel first.')
      return
    }

    const payload = {
      reel_number: editingDispatchId ? editingReelNumber : form.reel_number,
      date: form.date,
      dispatch_type: form.dispatch_type,
      sold_form: form.sold_form,
      job_card_number: form.sold_form === 'cutting' ? (form.job_card_number || null) : null,
      remarks: form.remarks || null,
      edited_by: user.id,
    }

    if (form.dispatch_type === 'partial') {
      const remSize = Number(form.remaining_size_cm)
      if (!form.remaining_size_cm || Number.isNaN(remSize) || remSize < 0 || remSize >= baseline.size_cm) {
        setError(`Remaining size must be between 0 and ${baseline.size_cm} cm (less than the current size — otherwise nothing was cut).`)
        return
      }
      payload.remaining_size_cm = remSize
      payload.remaining_gross_weight = round3((baseline.gross_weight * remSize) / baseline.size_cm)
      payload.remaining_kanta_weight = round3((baseline.kanta_weight * remSize) / baseline.size_cm)
      payload.remaining_net_weight = baseline.net_weight != null ? round3((baseline.net_weight * remSize) / baseline.size_cm) : null
      payload.cutting_name = form.cutting_name || baseline.cutting_name || null
    } else {
      payload.remaining_size_cm = null
      payload.remaining_gross_weight = null
      payload.remaining_kanta_weight = null
      payload.remaining_net_weight = null
      payload.cutting_name = null
    }

    let validCuts = []
    if (form.sold_form === 'cutting') {
      validCuts = cutItems.filter((r) => r.cut_size_cm.trim() && r.weight_kg && r.sold_to.trim())
      if (validCuts.length === 0) {
        setError('Add at least one cut size with a weight and a client sold to.')
        return
      }
      payload.sold_to = null
      payload.kanta_weight = null
    } else {
      if (!form.sold_to.trim() || !form.kanta_weight) {
        setError('Enter who it was sold to and the kanta weight.')
        return
      }
      payload.sold_to = form.sold_to.trim()
      payload.kanta_weight = Number(form.kanta_weight)
    }

    setSubmitting(true)

    let dispatchId = editingDispatchId
    if (editingDispatchId) {
      const { error } = await supabase.from('reel_dispatches').update(payload).eq('reel_dispatch_id', editingDispatchId)
      if (error) {
        setSubmitting(false)
        setError(error.message)
        return
      }
      const { error: deleteError } = await supabase.from('reel_dispatch_cuts').delete().eq('reel_dispatch_id', editingDispatchId)
      if (deleteError) {
        setSubmitting(false)
        setError(deleteError.message)
        return
      }
    } else {
      const { data, error } = await supabase.from('reel_dispatches').insert(payload).select().single()
      if (error) {
        setSubmitting(false)
        setError(error.message)
        return
      }
      dispatchId = data.reel_dispatch_id
    }

    if (form.sold_form === 'cutting') {
      const { error: cutsError } = await supabase.from('reel_dispatch_cuts').insert(
        validCuts.map((r) => ({
          reel_dispatch_id: dispatchId,
          cut_size_cm: r.cut_size_cm.trim(),
          weight_kg: Number(r.weight_kg),
          bundle_count: r.bundle_count ? Number(r.bundle_count) : null,
          sheets_per_bundle: r.sheets_per_bundle ? Number(r.sheets_per_bundle) : null,
          extra_sheets: r.extra_sheets ? Number(r.extra_sheets) : null,
          sold_to: r.sold_to.trim(),
          remarks: r.remarks || null,
          edited_by: user.id,
        }))
      )
      if (cutsError) {
        setSubmitting(false)
        setError(cutsError.message)
        return
      }
    }

    setSubmitting(false)
    cancelEdit()
    loadReelStock()
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
      .from('reel_dispatches')
      .select(DISPATCH_SELECT)
      .gte('date', reportFrom)
      .lte('date', reportTo)
      .order('date', { ascending: true })
      .order('reel_dispatch_id', { ascending: true })
    setReportBusy(false)

    if (error) {
      setReportError(error.message)
      return
    }
    const withStatus = await attachDispatchStatus(data)
    downloadCsv(`reel-dispatches-${reportFrom}-to-${reportTo}.csv`, rowsToCsv(cutReportRows(withStatus), REPORT_COLUMNS))
  }

  const recentRows = useMemo(() => {
    const rows = []
    for (const d of recent) {
      if (d.sold_form === 'cutting' && d.reel_dispatch_cuts?.length) {
        d.reel_dispatch_cuts.forEach((c, idx) => rows.push({ key: `${d.reel_dispatch_id}-${c.cut_id}`, d, c, isFirst: idx === 0 }))
      } else {
        rows.push({ key: String(d.reel_dispatch_id), d, c: null, isFirst: true })
      }
    }
    return rows
  }, [recent])

  return (
    <div className="page">
      <h1>Reel Dispatches (outgoing reel stock)</h1>

      <form className="stack-form" onSubmit={handleSubmit}>
        {editingDispatchId ? (
          <label>
            Reel Number
            <input value={editingReelNumber} disabled />
          </label>
        ) : (
          <label>
            Reel Number
            <SearchableSelect
              options={reelOptions}
              value={form.reel_number}
              onChange={(v) => updateField('reel_number', v)}
              placeholder="Type to search…"
              required
            />
          </label>
        )}

        {baseline && (
          <p className="hint">
            Currently: {baseline.size_cm} cm, gross {baseline.gross_weight} kg, kanta {baseline.kanta_weight} kg
            {baseline.net_weight != null ? `, net ${baseline.net_weight} kg` : ''}
            {baseline.cutting_name ? ` @ ${baseline.cutting_name}` : ''}
          </p>
        )}

        <label>
          Date
          <input type="date" value={form.date} onChange={(e) => updateField('date', e.target.value)} required />
        </label>

        <label>
          Full or Partial
          <select value={form.dispatch_type} onChange={(e) => updateField('dispatch_type', e.target.value)}>
            <option value="full">Full reel sold</option>
            <option value="partial">Partial — some cut off, rest stays in stock</option>
          </select>
        </label>

        <label>
          Sold As
          <select value={form.sold_form} onChange={(e) => updateField('sold_form', e.target.value)}>
            <option value="reel">Reel (sold as it is)</option>
            <option value="cutting">Cutting (cut into sheets)</option>
          </select>
        </label>

        {form.sold_form === 'cutting' && (
          <label>
            Job Card Number
            <input value={form.job_card_number} onChange={(e) => updateField('job_card_number', e.target.value)} />
          </label>
        )}

        {form.dispatch_type === 'partial' && (
          <>
            <label>
              Remaining Size (cm) — what stays on the reel
              <input
                type="number"
                min="0"
                step="any"
                value={form.remaining_size_cm}
                onChange={(e) => updateField('remaining_size_cm', e.target.value)}
                required
              />
            </label>
            <label>
              Cutting / Location (for what remains)
              <input value={form.cutting_name} onChange={(e) => updateField('cutting_name', e.target.value)} />
            </label>
          </>
        )}

        {preview && (
          <p className="hint">
            Remaining on reel: {preview.remGross} kg gross / {preview.remKanta} kg kanta
            {preview.remNet != null ? ` / ${preview.remNet} kg net` : ''}.{' '}
            Approx. weight being dispatched now: {preview.dispatchedApproxWeight} kg.
          </p>
        )}

        {form.sold_form === 'reel' ? (
          <>
            <label>
              Sold To
              <input value={form.sold_to} onChange={(e) => updateField('sold_to', e.target.value)} required />
            </label>
            <label>
              Kanta Weight of sold reel (kg)
              <input type="number" min="0.01" step="any" value={form.kanta_weight} onChange={(e) => updateField('kanta_weight', e.target.value)} required />
            </label>
          </>
        ) : null}

        <label>
          Remarks
          <input value={form.remarks} onChange={(e) => updateField('remarks', e.target.value)} />
        </label>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : editingDispatchId ? 'Update dispatch' : 'Record reel dispatch'}
        </button>
        {editingDispatchId && <button type="button" onClick={cancelEdit}>Cancel</button>}
      </form>

      {form.sold_form === 'cutting' && (
        <>
          <h2>Cut sizes sold</h2>
          {cutItems.map((row, i) => (
            <div className="item-card" key={i}>
              <span className="hint">Cut {i + 1}</span>
              <label>
                Cut Size (cm) e.g. 78.75*51
                <input value={row.cut_size_cm} onChange={(e) => updateCutItem(i, 'cut_size_cm', e.target.value)} />
              </label>
              <label>
                Kanta Weight (kg)
                <input type="number" min="0.01" step="any" value={row.weight_kg} onChange={(e) => updateCutItem(i, 'weight_kg', e.target.value)} />
              </label>
              <label>
                Bundles
                <input type="number" min="0.01" step="any" value={row.bundle_count} onChange={(e) => updateCutItem(i, 'bundle_count', e.target.value)} />
              </label>
              <label>
                Sheets/Bundle
                <input type="number" min="0.01" step="any" value={row.sheets_per_bundle} onChange={(e) => updateCutItem(i, 'sheets_per_bundle', e.target.value)} />
              </label>
              <label>
                Extra Sheets (loose, not a full bundle)
                <input type="number" min="0.01" step="any" value={row.extra_sheets} onChange={(e) => updateCutItem(i, 'extra_sheets', e.target.value)} />
              </label>
              {totalSheets(row.bundle_count, row.sheets_per_bundle, row.extra_sheets) != null && (
                <span className="hint">Total sheets: {totalSheets(row.bundle_count, row.sheets_per_bundle, row.extra_sheets)}</span>
              )}
              <label>
                Sold To
                <input value={row.sold_to} onChange={(e) => updateCutItem(i, 'sold_to', e.target.value)} />
              </label>
              <label>
                Remarks
                <input value={row.remarks} onChange={(e) => updateCutItem(i, 'remarks', e.target.value)} />
              </label>
              {cutItems.length > 1 && (
                <button type="button" className="item-card-remove" onClick={() => removeCutItem(i)}>Remove</button>
              )}
            </div>
          ))}
          <button type="button" onClick={addCutItem}>Add cut size</button>
          {cutItemsTotal > 0 && <p className="hint">Total kanta weight across cut sizes: {round3(cutItemsTotal)} kg</p>}
        </>
      )}

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

      <h2>Recent reel dispatches</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Reel Number</th><th>Quality</th><th>Date</th><th>Type</th><th>Sold As</th><th>Job Card</th><th>Cut Size</th><th>Bundles</th><th>Sheets/Bundle</th><th>Extra Sheets</th><th>Total Sheets</th><th>Remaining Size</th><th>Remaining Gross</th><th>Remaining Kanta</th><th>Remaining Net</th><th>Sold To</th><th>Kanta Wt (sold)</th><th>Location</th><th>Material +/-</th><th>Remarks</th><th>Edited By</th><th></th>
            </tr>
          </thead>
          <tbody>
            {recentRows.map(({ key, d, c, isFirst }) => (
              <tr key={key}>
                <td>{d.reel_number}</td>
                <td>{d.reel_receipts?.quality}</td>
                <td>{d.date}</td>
                <td>{d.dispatch_type === 'full' ? 'Full' : 'Partial'}</td>
                <td>{d.sold_form === 'cutting' ? 'Cutting' : 'Reel'}</td>
                <td>{d.job_card_number}</td>
                <td>{c ? c.cut_size_cm : '—'}</td>
                <td>{c ? c.bundle_count ?? '—' : ''}</td>
                <td>{c ? c.sheets_per_bundle ?? '—' : ''}</td>
                <td>{c ? c.extra_sheets ?? '—' : ''}</td>
                <td>{c ? totalSheets(c.bundle_count, c.sheets_per_bundle, c.extra_sheets) ?? '—' : ''}</td>
                <td>{d.remaining_size_cm ?? '—'}</td>
                <td>{d.remaining_gross_weight ?? '—'}</td>
                <td>{d.remaining_kanta_weight ?? '—'}</td>
                <td>{d.remaining_net_weight ?? '—'}</td>
                <td>{c ? c.sold_to : d.sold_to}</td>
                <td>{c ? c.weight_kg : d.kanta_weight}</td>
                <td>{d.cutting_name}</td>
                <td>{isFirst ? d.reel_dispatch_status?.material_diff ?? '—' : ''}</td>
                <td>{c ? c.remarks : d.remarks}</td>
                <td>{d.profiles?.name}</td>
                <td>{isFirst && <button type="button" onClick={() => startEdit(d)}>Edit</button>}</td>
              </tr>
            ))}
            {recentRows.length === 0 && (
              <tr><td colSpan={22}>No reel dispatches yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
