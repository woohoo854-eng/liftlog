// CSV export for the Excel tracker, JSON backup/restore, and file download/share.

import { allSets, getMeta, setMeta, replaceAll, localDate } from './db.js';

// Columns 1-8 must stay exactly as v1 so pasting into the Excel Log tab keeps working.
const CSV_COLUMNS = ['Date', 'Day', 'Exercise', 'Set #', 'Weight (lb)', 'Reps', 'RIR', 'Notes', 'Variant', 'Unit', 'Assist (lb)'];

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// YYYY-MM-DD -> M/D/YYYY
function mdy(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

const chronological = (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);

// Sets saved before v1.1 have no unit; they were all pounds.
const withUnit = s => ({ unit: 'lb', ...s });

// range: 'new' (created after the last export) or 'all'. Demo rows never export.
export async function setsForExport(range) {
  const sets = (await allSets()).filter(s => !s.demo);
  const last = await getMeta('lastExport');
  const picked = range === 'new' && last ? sets.filter(s => s.createdAt > last) : sets;
  return picked.sort(chronological);
}

// exercises: Map of plan exercises by id. Exercise names come from the current plan so
// renamed exercises match the tracker; ids no longer in the plan keep their stored name.
export function csvFile(sets, exercises) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const raw of sets) {
    const s = withUnit(raw);
    const ex = exercises.get(s.exerciseId);
    const variant = s.variant ? (ex?.variants?.find(v => v.key === s.variant)?.label ?? s.variant) : '';
    const assist = ex?.assisted ? (s.assistLb ?? (s.unit === 'lb' ? s.weight : null)) : null;
    lines.push([mdy(s.date), s.dayLabel, ex?.name ?? s.exerciseName, s.setNumber, s.weight, s.reps, s.rir, s.notes,
      variant, s.unit, assist].map(csvCell).join(','));
  }
  // BOM so Excel reads UTF-8; CRLF line endings.
  const text = '﻿' + lines.join('\r\n') + '\r\n';
  return new File([text], `liftlog-${localDate()}.csv`, { type: 'text/csv' });
}

export async function markExported(sets) {
  const newest = sets.reduce((m, s) => (s.createdAt > m ? s.createdAt : m), '');
  const last = await getMeta('lastExport');
  if (newest && (!last || newest > last)) await setMeta('lastExport', newest);
}

export async function backupFile() {
  const sets = (await allSets()).filter(s => !s.demo).sort(chronological);
  const settings = await getMeta('settings');
  const data = { app: 'liftlog', format: 2, exportedAt: new Date().toISOString(), settings, sets };
  return new File([JSON.stringify(data, null, 1)], `liftlog-backup-${localDate()}.json`, { type: 'application/json' });
}

export const markBackedUp = () => setMeta('lastBackup', new Date().toISOString());

export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (data?.app !== 'liftlog' || !Array.isArray(data.sets)) throw new Error('That is not a LiftLog backup file.');
  const bad = data.sets.find(s => !s || !s.id || !s.date || !s.exerciseId);
  if (bad) throw new Error('The backup has a damaged set row; nothing was changed.');
  return data;
}

export async function restoreBackup(data) {
  await replaceAll(data.sets.map(withUnit));
  if (data.settings) await setMeta('settings', data.settings);
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Chrome checks both the extension and the MIME type, so test with a real-looking name.
export function canShareFiles(name, type) {
  try {
    return !!navigator.canShare?.({ files: [new File([''], name, { type })] });
  } catch {
    return false;
  }
}

// Resolves true if shared, false if the user cancelled the share sheet.
export async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: file.name });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') return false;
    throw err;
  }
}
