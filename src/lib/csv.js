function escapeCsvValue(value) {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export function rowsToCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvValue(c.label)).join(',')
  const lines = rows.map((row) => columns.map((c) => escapeCsvValue(c.value(row))).join(','))
  return [header, ...lines].join('\r\n')
}

export function downloadCsv(filename, csvContent) {
  // BOM so Excel opens UTF-8 content (em dashes, etc.) correctly
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

export function addMonths(dateStr, months) {
  const d = new Date(dateStr)
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

// always formats in India Standard Time, regardless of the device's own
// timezone setting — the whole team operates on IST, so this keeps "today"
// consistent even if someone's phone/laptop clock is misconfigured
const IST_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function formatIstDate(d) {
  return IST_FORMATTER.format(d)
}

export function todayStr() {
  return formatIstDate(new Date())
}

export function daysAgoStr(days) {
  return formatIstDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000))
}

// pulls the leading number out of a dimension string like "56*71" for numeric sorting
export function parseLeadingNumber(value) {
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY
  const match = String(value).match(/-?\d+(\.\d+)?/)
  return match ? parseFloat(match[0]) : Number.POSITIVE_INFINITY
}

export function byGsmThenSize(getGsm, getSizeCm) {
  return (a, b) => {
    const gsmA = getGsm(a) ?? Number.POSITIVE_INFINITY
    const gsmB = getGsm(b) ?? Number.POSITIVE_INFINITY
    if (gsmA !== gsmB) return gsmA - gsmB
    return parseLeadingNumber(getSizeCm(a)) - parseLeadingNumber(getSizeCm(b))
  }
}

export function byVarietyThenGsmSize(getVariety, getGsm, getSizeCm) {
  const gsmSizeCompare = byGsmThenSize(getGsm, getSizeCm)
  return (a, b) => {
    const varietyCompare = (getVariety(a) || '').toString().localeCompare((getVariety(b) || '').toString())
    if (varietyCompare !== 0) return varietyCompare
    return gsmSizeCompare(a, b)
  }
}

export const GST_PRESETS = ['0', '5', '12', '18', '28']

export function presetForRate(rate) {
  const str = String(rate)
  return GST_PRESETS.includes(str) ? str : 'other'
}
