import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { rowsToCsv, downloadCsv, todayStr } from '../lib/csv'

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
  { label: 'Received Date', value: (r) => r.received_date },
  { label: 'Last Dispatch Date', value: (r) => r.last_dispatch_date },
  { label: 'Pending Job Card', value: (r) => r.pending_job_card_number },
]

function round3(n) {
  return Math.round(n * 1000) / 1000
}

// a pending job card has already committed part (or all) of a reel to an
// order, even though it hasn't been physically cut/dispatched yet — show
// what will be left once it's fulfilled, not the untouched raw stock
function applyPendingJobCard(row, jc) {
  if (!jc) return row
  if (jc.dispatch_type === 'full') {
    return {
      ...row,
      size_cm: 0,
      size_in: 0,
      gross_weight: 0,
      kanta_weight: 0,
      net_weight: row.net_weight != null ? 0 : null,
      pending_job_card_number: jc.job_card_number,
    }
  }
  const remSize = jc.remaining_size_cm
  return {
    ...row,
    size_cm: remSize,
    size_in: row.size_cm > 0 ? round3((row.size_in * remSize) / row.size_cm) : row.size_in,
    gross_weight: round3((row.gross_weight * remSize) / row.size_cm),
    kanta_weight: round3((row.kanta_weight * remSize) / row.size_cm),
    net_weight: row.net_weight != null ? round3((row.net_weight * remSize) / row.size_cm) : null,
    cutting_name: jc.cutting_name || row.cutting_name,
    pending_job_card_number: jc.job_card_number,
  }
}

function matchesSearch(row, q) {
  const haystacks = [row.reel_number, row.quality, row.cutting_name].map((v) => v?.toLowerCase() ?? '')
  return haystacks.some((h) => h.includes(q))
}

export default function ReelStock() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [stockResult, jobCardsResult] = await Promise.all([
      supabase.from('reel_stock').select('*').order('reel_number', { ascending: true }),
      supabase.from('reel_job_cards').select('reel_number, job_card_number, dispatch_type, remaining_size_cm, cutting_name').eq('status', 'pending'),
    ])
    if (stockResult.error) {
      setError(stockResult.error.message)
      setLoading(false)
      return
    }
    if (jobCardsResult.error) {
      setError(jobCardsResult.error.message)
      setLoading(false)
      return
    }
    const jobCardByReel = new Map(jobCardsResult.data.map((jc) => [jc.reel_number, jc]))
    setRows(stockResult.data.map((row) => applyPendingJobCard(row, jobCardByReel.get(row.reel_number))))
    setLoading(false)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter((r) => matchesSearch(r, q)) : rows
  }, [rows, search])

  function handleDownload() {
    downloadCsv(`reel-stock-${todayStr()}.csv`, rowsToCsv(filtered, REPORT_COLUMNS))
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Reel Stock</h1>
        <input
          className="search-box"
          placeholder="Search reel number, quality, location…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" onClick={handleDownload} disabled={filtered.length === 0}>Download CSV</button>
      </div>

      {loading && <p>Loading…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && !error && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Reel Number</th><th>Quality</th><th>GSM</th><th>Size (cm)</th><th>Size (in)</th><th>Gross Wt</th><th>Kanta Wt</th><th>Net Wt</th><th>Cutting/Location</th><th>Received</th><th>Last Dispatch</th><th>Pending Job Card</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
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
                  <td>{r.received_date}</td>
                  <td>{r.last_dispatch_date || '—'}</td>
                  <td>{r.pending_job_card_number || '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={12}>No reels in stock.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
