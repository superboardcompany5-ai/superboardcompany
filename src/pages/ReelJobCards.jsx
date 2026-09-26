import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../hooks/useAuth'
import { todayStr } from '../lib/csv'
import SearchableSelect from '../components/SearchableSelect'

const emptyForm = {
  reel_number: '',
  date: todayStr(),
  dispatch_type: 'full',
  sold_form: 'reel',
  remaining_size_cm: '',
  cutting_name: '',
  sold_to: '',
  remarks: '',
}

const emptyCutItem = { cut_size_cm: '', sold_to: '', remarks: '' }

function round3(n) {
  return Math.round(n * 1000) / 1000
}

const JOB_CARD_SELECT =
  'job_card_id, job_card_number, reel_number, date, dispatch_type, sold_form, remaining_size_cm, cutting_name, sold_to, remarks, status, reel_receipts(quality, gsm), profiles(name), reel_job_card_cuts(job_card_cut_id, cut_size_cm, sold_to, remarks)'

export default function ReelJobCards() {
  const { user } = useAuth()
  const [reelStock, setReelStock] = useState([])
  const [pendingReelNumbers, setPendingReelNumbers] = useState(new Set())
  const [jobCards, setJobCards] = useState([])
  const [showHistory, setShowHistory] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [cutItems, setCutItems] = useState([{ ...emptyCutItem }])
  const [nextNumber, setNextNumber] = useState('')
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [editingJobCardId, setEditingJobCardId] = useState(null)
  const [editingReelNumber, setEditingReelNumber] = useState(null)

  const reelOptions = useMemo(
    () => reelStock
      .filter((r) => !pendingReelNumbers.has(r.reel_number))
      .map((r) => ({
        value: r.reel_number,
        label: `${r.reel_number} — ${r.quality} (${r.size_cm} cm, ${r.gross_weight} kg)${r.cutting_name ? ` @ ${r.cutting_name}` : ''}`,
      })),
    [reelStock, pendingReelNumbers]
  )

  const baseline = useMemo(() => {
    const reelNumber = editingJobCardId ? editingReelNumber : form.reel_number
    return reelStock.find((r) => r.reel_number === reelNumber) || null
  }, [editingJobCardId, editingReelNumber, reelStock, form.reel_number])

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

  useEffect(() => {
    loadReelStock()
    loadPendingReelNumbers()
  }, [])

  useEffect(() => {
    loadJobCards()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHistory])

  useEffect(() => {
    if (editingJobCardId) return
    supabase.rpc('peek_next_job_card_number', { for_date: form.date }).then(({ data, error }) => {
      if (!error) setNextNumber(data || '')
    })
  }, [form.date, editingJobCardId])

  async function loadReelStock() {
    const { data, error } = await supabase.from('reel_stock').select('*').order('reel_number')
    if (error) setError(error.message)
    else setReelStock(data ?? [])
  }

  // unlimited (not the display list, which is capped) so a reel with an old
  // pending job card still gets excluded from the "available reels" list
  async function loadPendingReelNumbers() {
    const { data, error } = await supabase.from('reel_job_cards').select('reel_number').eq('status', 'pending')
    if (error) {
      setError(error.message)
      return
    }
    setPendingReelNumbers(new Set((data ?? []).map((r) => r.reel_number)))
  }

  async function loadJobCards() {
    let query = supabase.from('reel_job_cards').select(JOB_CARD_SELECT).order('job_card_id', { ascending: false }).limit(50)
    if (!showHistory) query = query.eq('status', 'pending')
    const { data, error } = await query
    if (error) setError(error.message)
    else setJobCards(data ?? [])
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
    setEditingJobCardId(null)
    setEditingReelNumber(null)
    setForm(emptyForm)
    setCutItems([{ ...emptyCutItem }])
  }

  function startEdit(jc) {
    setError(null)
    setEditingJobCardId(jc.job_card_id)
    setEditingReelNumber(jc.reel_number)
    setForm({
      reel_number: jc.reel_number,
      date: jc.date,
      dispatch_type: jc.dispatch_type,
      sold_form: jc.sold_form,
      remaining_size_cm: jc.remaining_size_cm != null ? String(jc.remaining_size_cm) : '',
      cutting_name: jc.cutting_name || '',
      sold_to: jc.sold_to || '',
      remarks: jc.remarks || '',
    })
    setCutItems(
      jc.sold_form === 'cutting' && jc.reel_job_card_cuts?.length
        ? jc.reel_job_card_cuts.map((c) => ({
            cut_size_cm: c.cut_size_cm,
            sold_to: c.sold_to,
            remarks: c.remarks || '',
          }))
        : [{ ...emptyCutItem }]
    )
  }

  async function cancelJobCard(jobCardId) {
    setError(null)
    const { error } = await supabase.from('reel_job_cards').update({ status: 'cancelled' }).eq('job_card_id', jobCardId)
    if (error) {
      setError(error.message)
      return
    }
    loadPendingReelNumbers()
    loadJobCards()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!baseline) {
      setError('Pick a reel first.')
      return
    }

    const payload = {
      date: form.date,
      dispatch_type: form.dispatch_type,
      sold_form: form.sold_form,
      remarks: form.remarks || null,
      edited_by: user.id,
    }
    if (!editingJobCardId) {
      payload.reel_number = form.reel_number
    }

    if (form.dispatch_type === 'partial') {
      const remSize = Number(form.remaining_size_cm)
      if (!form.remaining_size_cm || Number.isNaN(remSize) || remSize < 0 || remSize >= baseline.size_cm) {
        setError(`Remaining size must be between 0 and ${baseline.size_cm} cm (less than the current size — otherwise nothing was cut).`)
        return
      }
      payload.remaining_size_cm = remSize
      payload.cutting_name = form.cutting_name || baseline.cutting_name || null
    } else {
      payload.remaining_size_cm = null
      payload.cutting_name = null
    }

    let validCuts = []
    if (form.sold_form === 'cutting') {
      const filledCuts = cutItems.filter((r) => r.cut_size_cm.trim() || r.sold_to.trim())
      if (filledCuts.length === 0) {
        setError('Add at least one cut size with a client sold to.')
        return
      }
      const incomplete = filledCuts.find((r) => !r.cut_size_cm.trim() || !r.sold_to.trim())
      if (incomplete) {
        setError('Each cut size needs both a size and who it will be sold to.')
        return
      }
      validCuts = filledCuts
      payload.sold_to = null
    } else {
      if (!form.sold_to.trim()) {
        setError('Enter who it will be sold to.')
        return
      }
      payload.sold_to = form.sold_to.trim()
    }

    setSubmitting(true)

    let jobCardId = editingJobCardId
    if (editingJobCardId) {
      const { error } = await supabase.from('reel_job_cards').update(payload).eq('job_card_id', editingJobCardId)
      if (error) {
        setSubmitting(false)
        setError(error.message)
        return
      }
      const { error: deleteError } = await supabase.from('reel_job_card_cuts').delete().eq('job_card_id', editingJobCardId)
      if (deleteError) {
        setSubmitting(false)
        setError(deleteError.message)
        return
      }
    } else {
      const { data, error } = await supabase.from('reel_job_cards').insert(payload).select().single()
      if (error) {
        setSubmitting(false)
        setError(error.message)
        return
      }
      jobCardId = data.job_card_id
    }

    if (form.sold_form === 'cutting') {
      const { error: cutsError } = await supabase.from('reel_job_card_cuts').insert(
        validCuts.map((r) => ({
          job_card_id: jobCardId,
          cut_size_cm: r.cut_size_cm.trim(),
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
    loadPendingReelNumbers()
    loadJobCards()
  }

  const jobCardRows = useMemo(() => {
    const rows = []
    for (const jc of jobCards) {
      if (jc.sold_form === 'cutting' && jc.reel_job_card_cuts?.length) {
        jc.reel_job_card_cuts.forEach((c, idx) => rows.push({ key: `${jc.job_card_id}-${c.job_card_cut_id}`, jc, c, isFirst: idx === 0 }))
      } else {
        rows.push({ key: String(jc.job_card_id), jc, c: null, isFirst: true })
      }
    }
    return rows
  }, [jobCards])

  return (
    <div className="page">
      <h1>Reel Job Cards (create an order before it's dispatched)</h1>

      <form className="stack-form" onSubmit={handleSubmit}>
        {!editingJobCardId && nextNumber && <p className="hint">Next job card number: {nextNumber}</p>}

        {editingJobCardId ? (
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

        <label>
          Remarks
          <input value={form.remarks} onChange={(e) => updateField('remarks', e.target.value)} />
        </label>

        {preview && (
          <p className="hint form-section">
            Remaining on reel: {preview.remGross} kg gross / {preview.remKanta} kg kanta
            {preview.remNet != null ? ` / ${preview.remNet} kg net` : ''}.{' '}
            Approx. weight to be dispatched: {preview.dispatchedApproxWeight} kg (kanta weight is entered later, at actual dispatch).
          </p>
        )}

        {form.sold_form === 'reel' && (
          <label>
            Sold To
            <input value={form.sold_to} onChange={(e) => updateField('sold_to', e.target.value)} required />
          </label>
        )}

        {form.sold_form === 'cutting' && (
          <div className="form-section">
            <h2>Cut sizes planned</h2>
            {cutItems.map((row, i) => (
              <div className="item-card" key={i}>
                <span className="hint">Cut {i + 1}</span>
                <label>
                  Cut Size (cm) e.g. 78.75*51
                  <input value={row.cut_size_cm} onChange={(e) => updateCutItem(i, 'cut_size_cm', e.target.value)} />
                </label>
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
            <p className="hint">Kanta weight and bundle/sheet counts for each cut are entered later, when the job card is actually dispatched.</p>
          </div>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : editingJobCardId ? 'Update job card' : 'Create job card'}
        </button>
        {editingJobCardId && <button type="button" onClick={cancelEdit}>Cancel edit</button>}
      </form>

      {error && <p className="error">{error}</p>}

      <h2>Job cards</h2>
      <label className="hint">
        <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} /> Show dispatched/cancelled
      </label>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Job Card #</th><th>Reel Number</th><th>Quality</th><th>Date</th><th>Type</th><th>Sold As</th><th>Cut Size</th><th>Sold To</th><th>Remaining Size</th><th>Location</th><th>Remarks</th><th>Status</th><th>Edited By</th><th></th>
            </tr>
          </thead>
          <tbody>
            {jobCardRows.map(({ key, jc, c, isFirst }) => (
              <tr key={key} className={jc.status !== 'pending' ? 'archived-row' : ''}>
                <td>{jc.job_card_number}</td>
                <td>{jc.reel_number}</td>
                <td>{jc.reel_receipts?.quality}</td>
                <td>{jc.date}</td>
                <td>{jc.dispatch_type === 'full' ? 'Full' : 'Partial'}</td>
                <td>{jc.sold_form === 'cutting' ? 'Cutting' : 'Reel'}</td>
                <td>{c ? c.cut_size_cm : '—'}</td>
                <td>{c ? c.sold_to : jc.sold_to}</td>
                <td>{jc.remaining_size_cm ?? '—'}</td>
                <td>{jc.cutting_name}</td>
                <td>{c ? c.remarks : jc.remarks}</td>
                <td>{jc.status}</td>
                <td>{jc.profiles?.name}</td>
                <td>
                  {isFirst && jc.status === 'pending' && (
                    <>
                      <button type="button" onClick={() => startEdit(jc)}>Edit</button>{' '}
                      <button type="button" onClick={() => cancelJobCard(jc.job_card_id)}>Cancel</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {jobCardRows.length === 0 && (
              <tr><td colSpan={14}>No job cards yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
