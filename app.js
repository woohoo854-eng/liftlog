// LiftLog: hash router and screens (Today, Set Logger, Settings).

import { addSet, putSet, writeSets, setsByExercise, setsByDate, getMeta, setMeta, localDate } from './db.js';
import * as exp from './export.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const DEFAULT_RIR = 2;
const BACKUP_WARN_DAYS = 7;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let plan;
const exercises = new Map(); // id -> exercise, every list, plan order
const listOf = new Map();    // id -> list key
let settings;
let todayHasSets = false;
let renderedDate = null;
let wakeLock = null;

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const bySetNumber = (a, b) => a.setNumber - b.setNumber;

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${m}/${d}`;
}

function daysSince(isoTimestamp) {
  return isoTimestamp ? (Date.now() - Date.parse(isoTimestamp)) / 86400000 : Infinity;
}

function fmtSet(ex, s) {
  const w = ex?.bodyweight ? (s.weight ? `BW+${num(s.weight)}` : 'BW') : num(s.weight);
  return `${w}×${s.reps}${s.rir == null ? '' : ` @${s.rir}`}`;
}

function targetText(ex) {
  const reps = ex.repMin == null ? 'max' : ex.repMin === ex.repMax ? ex.repMin : `${ex.repMin}–${ex.repMax}`;
  return `${ex.sets} × ${reps}`;
}

function metaText(ex) {
  const parts = [targetText(ex)];
  if (ex.machine != null) parts.push(`Machine #${ex.machine}`);
  if (ex.perSide) parts.push('per side');
  if (ex.assisted) parts.push('assisted');
  return parts.join(' · ');
}

function listName(key) {
  return plan.days.find(d => d.list === key)?.label.split(': ')[1] ?? key[0].toUpperCase() + key.slice(1);
}

function stepFor(ex) {
  if (ex.step != null) return ex.step;
  return settings.steps[ex.equipment] ?? plan.defaults?.step?.[ex.equipment] ?? 5;
}

const hintText = ex => (ex.assisted ? 'Reduce assist' : 'Add weight');

// Double progression: last session hit repMax on every planned set at RIR >= 1.
function readyToProgress(ex, last) {
  if (!last || ex.repMax == null || last.sets.length < ex.sets) return false;
  return last.sets.slice(0, ex.sets).every(s => s.reps >= ex.repMax && s.rir != null && s.rir >= 1);
}

function lastText(ex, last) {
  if (!last) return '<div class="last muted">No history yet</div>';
  return `<div class="last"><span class="lbl">LAST TIME</span><b>${shortDate(last.date)}:</b> ${last.sets.map(s => fmtSet(ex, s)).join(', ')}</div>`;
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2000);
}

// ---------- data ----------

async function loadSettings() {
  const defaults = { keepAwake: true, steps: {} };
  for (const ex of exercises.values()) {
    const step = plan.defaults?.step?.[ex.equipment];
    if (step) defaults.steps[ex.equipment] = step;
  }
  const saved = (await getMeta('settings')) || {};
  return { ...defaults, ...saved, steps: { ...defaults.steps, ...saved.steps } };
}

const saveSettings = () => setMeta('settings', settings);

// Most recent date before today on which this exercise was logged.
async function lastSession(exId, today) {
  const sets = (await setsByExercise(exId)).filter(s => s.date < today && !s.demo);
  if (!sets.length) return null;
  const date = sets.reduce((m, s) => (s.date > m ? s.date : m), '');
  return { date, sets: sets.filter(s => s.date === date).sort(bySetNumber) };
}

async function currentDayLabel(today, todaySets) {
  const choice = await getMeta('dayChoice');
  if (choice?.date === today && plan.days.some(d => d.label === choice.label)) return choice.label;
  const logged = todaySets[0]?.dayLabel;
  if (logged) return logged;
  return plan.days.find(d => d.weekday === new Date().getDay())?.label ?? null;
}

// Today's working list: the day's planned exercises, plus any other plan exercise that has
// sets today (or is being opened right now via extraId).
async function loadToday(extraId) {
  const today = localDate();
  const todaySets = (await setsByDate(today)).filter(s => !s.demo);
  todayHasSets = todaySets.length > 0;
  renderedDate = today;
  const dayLabel = await currentDayLabel(today, todaySets);
  const day = plan.days.find(d => d.label === dayLabel);
  const planned = day ? plan.lists[day.list] : [];
  const plannedIds = new Set(planned.map(e => e.id));
  const counts = {};
  for (const s of todaySets) counts[s.exerciseId] = (counts[s.exerciseId] || 0) + 1;
  const added = [...exercises.values()].filter(e => !plannedIds.has(e.id) && (counts[e.id] || e.id === extraId));
  return { today, todaySets, dayLabel, planned, added, list: [...planned, ...added], counts };
}

function progress(ctx) {
  let done = 0, total = 0;
  for (const ex of ctx.list) {
    const c = ctx.counts[ex.id] || 0;
    if (!ctx.planned.includes(ex) && !c) continue;
    total += ex.sets;
    done += Math.min(c, ex.sets);
  }
  return { done, total };
}

// ---------- wake lock ----------

async function updateWakeLock() {
  const want = settings?.keepAwake && todayHasSets && document.visibilityState === 'visible';
  if (want && !wakeLock && 'wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* unsupported or denied: fall back silently */ }
  } else if (!want && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// ---------- Today ----------

function groupBySuperset(list) {
  const groups = [];
  for (const ex of list) {
    const key = ex.slot.charAt(0);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) groups.push(g = { key, items: [] });
    g.items.push(ex);
  }
  return groups;
}

function card(ex, ctx, last) {
  const c = ctx.counts[ex.id] || 0;
  const done = c >= ex.sets;
  return `
    <a class="card${done ? ' done' : ''}" href="#/log/${ex.id}">
      <div class="card-head">
        <span class="slot">${esc(ex.slot)}</span>
        <span class="name">${esc(ex.name)}</span>
        <span class="count">${done ? '✓ ' : ''}${c}/${ex.sets}</span>
      </div>
      <div class="meta">${esc(metaText(ex))}</div>
      ${ex.note ? `<div class="note">${esc(ex.note)}</div>` : ''}
      ${lastText(ex, last)}
      ${readyToProgress(ex, last) ? `<span class="badge">${hintText(ex)}</span>` : ''}
    </a>`;
}

function dayPicker(today) {
  return `
    <header class="top"><h1>${shortDate(today)}</h1></header>
    <p class="muted">Gym's closed today. Which workout are you doing?</p>
    <div class="picker">
      ${plan.days.map(d => `<button data-day="${esc(d.label)}">${esc(d.label)}</button>`).join('')}
    </div>`;
}

async function renderToday() {
  const ctx = await loadToday();
  if (!ctx.dayLabel) {
    app.innerHTML = dayPicker(ctx.today);
    bindDayChoice(ctx.today);
    return;
  }

  const lasts = await Promise.all(ctx.list.map(ex => lastSession(ex.id, ctx.today)));
  const lastById = Object.fromEntries(ctx.list.map((ex, i) => [ex.id, lasts[i]]));
  const { done, total } = progress(ctx);
  const pct = total ? Math.round((done / total) * 100) : 0;

  let nudge = '';
  if (total && done >= total) {
    const lastBackup = await getMeta('lastBackup');
    if (daysSince(lastBackup) > BACKUP_WARN_DAYS) {
      nudge = `<a class="banner" href="#/settings" data-replace>All sets done. Back up now — last backup: ${lastBackup ? shortDate(localDate(new Date(lastBackup))) : 'never'}</a>`;
    }
  }

  const groupsHtml = groupBySuperset(ctx.planned).map(g => `
    <h2>${g.items.length > 1 ? `Superset ${esc(g.key)}` : esc(g.key)}</h2>
    ${g.items.map(ex => card(ex, ctx, lastById[ex.id])).join('')}`).join('');

  const addedHtml = ctx.added.length
    ? `<h2>Added</h2>${ctx.added.map(ex => card(ex, ctx, lastById[ex.id])).join('')}`
    : '';

  const onList = new Set(ctx.list.map(e => e.id));
  const others = [...exercises.values()]
    .filter(e => !onList.has(e.id))
    .sort((a, b) => (listOf.get(b.id) === 'optional') - (listOf.get(a.id) === 'optional'));

  app.innerHTML = `
    <header class="top">
      <h1>${shortDate(ctx.today)}</h1>
      <select id="day" aria-label="Workout day">
        ${plan.days.map(d => `<option${d.label === ctx.dayLabel ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
      </select>
    </header>
    <div class="progress">
      <div class="progress-text">${done} of ${total} sets</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>
    ${nudge}
    ${groupsHtml}
    ${addedHtml}
    <details class="add">
      <summary>+ Add exercise</summary>
      ${others.map(ex => `
        <a class="add-item" href="#/log/${ex.id}">
          <span>${esc(ex.name)}</span>
          <small class="muted">${esc(listName(listOf.get(ex.id)))} · ${esc(ex.slot)}</small>
        </a>`).join('')}
    </details>`;

  app.querySelector('#day').onchange = async e => {
    await setMeta('dayChoice', { date: ctx.today, label: e.target.value });
    renderToday();
  };
}

function bindDayChoice(today) {
  app.querySelectorAll('[data-day]').forEach(btn => {
    btn.onclick = async () => {
      await setMeta('dayChoice', { date: today, label: btn.dataset.day });
      renderToday();
    };
  });
}

// ---------- Set Logger ----------

async function renderLogger(exId, editId) {
  const ex = exercises.get(exId);
  if (!ex) return location.replace('#/today');
  const ctx = await loadToday(exId);
  if (!ctx.dayLabel) return location.replace('#/today');

  const mine = ctx.todaySets.filter(s => s.exerciseId === exId).sort(bySetNumber);
  const last = await lastSession(exId, ctx.today);
  const editing = editId ? mine.find(s => s.id === editId) : null;
  const setNum = editing ? editing.setNumber : mine.length + 1;
  const lastMatch = last?.sets.find(s => s.setNumber === setNum);

  const weight = editing ? editing.weight : (mine.at(-1)?.weight ?? last?.sets.at(-1)?.weight ?? (ex.bodyweight ? 0 : ''));
  const reps = editing ? editing.reps : '';
  const rir = editing ? editing.rir : DEFAULT_RIR;
  const step = stepFor(ex);

  const idx = ctx.list.findIndex(e => e.id === exId);
  const prev = ctx.list[idx - 1];
  const next = ctx.list[idx + 1];

  const weightLabel = ex.assisted ? 'Assist (lb)' : ex.bodyweight ? 'Added weight (lb)' : 'Weight (lb)';
  const weightSub = [ex.perSide && 'per side', ex.assisted && 'lower = stronger', ex.bodyweight && '0 = bodyweight']
    .filter(Boolean).join(' · ');

  const chips = ctx.list.map(e => {
    const c = ctx.counts[e.id] || 0;
    return `<button type="button" class="chip${e.id === exId ? ' active' : ''}${c >= e.sets ? ' done' : ''}" data-ex="${e.id}">${esc(e.name)} <b>${c}/${e.sets}</b></button>`;
  }).join('');

  const rows = mine.map(s => `
    <div class="set-row${editing?.id === s.id ? ' editing' : ''}">
      <span class="n">Set ${s.setNumber}</span>
      <span class="v">${fmtSet(ex, s)}${s.notes ? `<small>${esc(s.notes)}</small>` : ''}</span>
      <button type="button" data-edit="${s.id}" aria-label="Edit set ${s.setNumber}">Edit</button>
      <button type="button" data-del="${s.id}" aria-label="Delete set ${s.setNumber}">✕</button>
    </div>`).join('');

  app.innerHTML = `
    <div class="lg-top">
      <button type="button" class="back" data-back>‹ Today</button>
      <span class="muted">${esc(ctx.dayLabel)}</span>
    </div>
    <div class="strip">${chips}</div>
    <section class="ex-head">
      <div class="title"><span class="slot">${esc(ex.slot)}</span><h1>${esc(ex.name)}</h1></div>
      <div class="meta">${esc(metaText(ex))}</div>
      ${ex.note ? `<div class="note">${esc(ex.note)}</div>` : ''}
      ${readyToProgress(ex, last) ? `<span class="badge">${hintText(ex)}</span>` : ''}
      ${lastText(ex, last)}
    </section>
    ${lastMatch ? `<div class="lastset">Last time, set ${setNum}: ${fmtSet(ex, lastMatch)}</div>` : ''}

    <form id="setform" autocomplete="off" novalidate>
      <div class="field-label">${weightLabel}${weightSub ? ` <small>${weightSub}</small>` : ''}</div>
      <div class="stepper${step ? '' : ' single'}">
        ${step ? `<button type="button" data-step="weight" data-dir="-1" aria-label="Less weight">−</button>` : ''}
        <input name="weight" inputmode="decimal" value="${esc(weight === '' ? '' : num(weight))}" aria-label="${weightLabel}">
        ${step ? `<button type="button" data-step="weight" data-dir="1" aria-label="More weight">+</button>` : ''}
      </div>

      <div class="field-label">Reps${ex.repMin != null ? ` <small>target ${ex.repMin === ex.repMax ? ex.repMin : `${ex.repMin}–${ex.repMax}`}</small>` : ''}</div>
      <div class="stepper">
        <button type="button" data-step="reps" data-dir="-1" aria-label="Fewer reps">−</button>
        <input name="reps" inputmode="numeric" pattern="[0-9]*" value="${esc(reps)}" placeholder="${lastMatch ? lastMatch.reps : ''}" aria-label="Reps">
        <button type="button" data-step="reps" data-dir="1" aria-label="More reps">+</button>
      </div>

      <div class="field-label">RIR <small>reps in reserve</small></div>
      <div class="rir">
        ${[0, 1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rir" value="${n}"${n === rir ? ' checked' : ''}><span>${n}</span></label>`).join('')}
      </div>

      <input class="notes" name="notes" maxlength="120" placeholder="Notes (optional)" value="${esc(editing?.notes ?? '')}">
      <p class="error" hidden></p>
      ${editing ? '<button type="button" class="cancel" data-cancel>Cancel edit</button>' : ''}
    </form>

    ${mine.length ? `<h2>Today</h2>${rows}` : ''}

    <div class="actionbar">
      <button type="button" data-go="${prev?.id ?? ''}" aria-label="Previous exercise"${prev ? '' : ' disabled'}>‹</button>
      <button type="submit" form="setform" class="primary">${editing ? 'Save' : 'Log'} set ${setNum}</button>
      <button type="button" data-go="${next?.id ?? ''}" aria-label="Next exercise"${next ? '' : ' disabled'}>›</button>
    </div>`;

  app.querySelector('.chip.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const form = app.querySelector('#setform');
  const error = form.querySelector('.error');
  const showError = msg => { error.textContent = msg; error.hidden = false; };

  form.querySelectorAll('[data-step]').forEach(btn => {
    btn.onclick = () => {
      const input = form.elements[btn.dataset.step];
      const delta = (btn.dataset.step === 'weight' ? step : 1) * Number(btn.dataset.dir);
      const base = parseFloat(input.value) || (btn.dataset.step === 'reps' && input.placeholder ? Number(input.placeholder) - delta : 0);
      input.value = num(Math.max(0, Math.round((base + delta) * 100) / 100));
    };
  });

  form.onsubmit = async e => {
    e.preventDefault();
    const w = parseFloat(form.elements.weight.value);
    const r = Number(form.elements.reps.value);
    if (!Number.isFinite(w) || w < 0) return showError('Enter a weight.');
    if (!Number.isInteger(r) || r < 1) return showError('Enter reps.');
    const rirValue = form.elements.rir.value;
    const fields = { weight: w, reps: r, rir: rirValue === '' ? null : Number(rirValue), notes: form.elements.notes.value.trim() };

    if (editing) {
      await putSet({ ...editing, ...fields });
      toast(`Set ${setNum} saved`);
    } else {
      await addSet({
        id: crypto.randomUUID(),
        date: ctx.today,
        dayLabel: ctx.dayLabel,
        exerciseId: ex.id,
        exerciseName: ex.name,
        setNumber: setNum,
        ...fields,
        createdAt: new Date().toISOString(),
      });
      toast(`Set ${setNum} logged`);
    }
    todayHasSets = true;
    updateWakeLock();
    renderLogger(exId);
  };

  app.querySelectorAll('[data-ex], [data-go]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.ex ?? btn.dataset.go;
      if (id) location.replace(`#/log/${id}`);
    };
  });
  app.querySelectorAll('[data-edit]').forEach(btn => { btn.onclick = () => renderLogger(exId, btn.dataset.edit); });
  app.querySelector('[data-cancel]')?.addEventListener('click', () => renderLogger(exId));
  app.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const set = mine.find(s => s.id === btn.dataset.del);
      if (!confirm(`Delete set ${set.setNumber} (${fmtSet(ex, set)})?`)) return;
      const remaining = mine.filter(s => s.id !== set.id).map((s, i) => ({ ...s, setNumber: i + 1 }));
      await writeSets({ del: [set.id], put: remaining });
      toast('Set deleted');
      renderLogger(exId);
    };
  });
}

// ---------- Settings ----------

async function appVersion() {
  const keys = 'caches' in window ? await caches.keys() : [];
  return keys.find(k => k.startsWith('liftlog-'))?.slice('liftlog-'.length) ?? 'dev (no offline cache)';
}

async function renderSettings() {
  const [persisted, lastBackup, newSets, allSetsForExport, version] = await Promise.all([
    navigator.storage?.persisted?.() ?? false,
    getMeta('lastBackup'),
    exp.setsForExport('new'),
    exp.setsForExport('all'),
    appVersion(),
  ]);
  const backupOld = daysSince(lastBackup) > BACKUP_WARN_DAYS;
  const canShareCsv = exp.canShareFiles('x.csv', 'text/csv');
  const canShareJson = exp.canShareFiles('x.json', 'application/json');
  const equipment = Object.keys(settings.steps);

  app.innerHTML = `
    <header class="top"><h1>Settings</h1></header>

    <h2>Export to Excel</h2>
    <div class="panel">
      <p class="muted small">${newSets.length} new since last export · ${allSetsForExport.length} total</p>
      <div class="seg">
        <label><input type="radio" name="range" value="new" checked><span>New sets</span></label>
        <label><input type="radio" name="range" value="all"><span>All sets</span></label>
      </div>
      <div class="row">
        <button type="button" class="primary" id="csv-dl">Download CSV</button>
        ${canShareCsv ? '<button type="button" id="csv-share">Share CSV</button>' : ''}
      </div>
    </div>

    <h2>Backup</h2>
    <div class="panel">
      <p class="${backupOld ? 'warn' : 'muted'}">Last backup: ${lastBackup ? shortDate(localDate(new Date(lastBackup))) : 'never'}${backupOld ? ' — back up soon' : ''}</p>
      <div class="row">
        <button type="button" id="json-dl">Download</button>
        ${canShareJson ? '<button type="button" id="json-share">Share</button>' : ''}
      </div>
      <div class="row">
        <label class="button">Restore from backup<input type="file" id="json-in" accept=".json,application/json" hidden></label>
      </div>
      <p class="small warn">Your sets live only on this phone. Uninstalling the app or clearing Chrome's site data deletes them. Keep a recent backup.</p>
    </div>

    <h2>Screen</h2>
    <div class="panel">
      <label class="toggle"><span>Keep screen awake while logging</span><input type="checkbox" id="awake"${settings.keepAwake ? ' checked' : ''}></label>
    </div>

    <h2>Weight steps (lb)</h2>
    <div class="panel steps">
      ${equipment.map(eq => `<label>${esc(eq)}<input inputmode="decimal" data-eq="${esc(eq)}" value="${num(settings.steps[eq])}"></label>`).join('')}
    </div>

    <h2>Storage</h2>
    <div class="panel">
      <p>${persisted ? 'Protected: the phone will not clear your data to free space.' : 'Not protected yet. Installing the app to the home screen usually fixes this.'}</p>
      ${persisted ? '' : '<div class="row"><button type="button" id="persist">Ask again</button></div>'}
    </div>

    <p class="muted small version">LiftLog ${esc(version)}</p>`;

  const range = () => app.querySelector('[name=range]:checked').value;

  async function exportCsv(share) {
    const sets = await exp.setsForExport(range());
    if (!sets.length) return toast('No new sets to export');
    const file = exp.csvFile(sets);
    if (share) {
      if (!(await exp.shareFile(file))) return;
    } else {
      exp.downloadFile(file);
    }
    await exp.markExported(sets);
    toast(`Exported ${sets.length} sets`);
    renderSettings();
  }

  async function exportJson(share) {
    const file = await exp.backupFile();
    if (share) {
      if (!(await exp.shareFile(file))) return;
    } else {
      exp.downloadFile(file);
    }
    await exp.markBackedUp();
    toast('Backup saved');
    renderSettings();
  }

  const onError = err => toast(err.message || 'Something went wrong');
  app.querySelector('#csv-dl').onclick = () => exportCsv(false).catch(onError);
  app.querySelector('#csv-share')?.addEventListener('click', () => exportCsv(true).catch(onError));
  app.querySelector('#json-dl').onclick = () => exportJson(false).catch(onError);
  app.querySelector('#json-share')?.addEventListener('click', () => exportJson(true).catch(onError));

  app.querySelector('#json-in').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = exp.parseBackup(await file.text());
      const current = allSetsForExport.length;
      if (!confirm(`Replace the ${current} sets on this phone with the ${data.sets.length} sets in this backup?`)) return;
      await exp.restoreBackup(data);
      settings = await loadSettings();
      toast(`Restored ${data.sets.length} sets`);
      renderSettings();
    } catch (err) {
      alert(err.message);
    }
  };

  app.querySelector('#awake').onchange = async e => {
    settings.keepAwake = e.target.checked;
    await saveSettings();
    updateWakeLock();
  };

  app.querySelectorAll('[data-eq]').forEach(input => {
    input.onchange = async () => {
      const v = parseFloat(input.value);
      if (!(v > 0)) { input.value = num(settings.steps[input.dataset.eq]); return; }
      settings.steps[input.dataset.eq] = v;
      await saveSettings();
      toast('Saved');
    };
  });

  app.querySelector('#persist')?.addEventListener('click', async () => {
    await navigator.storage?.persist?.();
    renderSettings();
  });
}

// ---------- router ----------

async function route() {
  const [, screen, arg] = location.hash.split('/');
  document.body.classList.toggle('logging', screen === 'log');
  nav.querySelectorAll('[data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === (screen === 'settings' ? 'settings' : 'today')));
  try {
    if (screen === 'log' && arg) await renderLogger(decodeURIComponent(arg));
    else if (screen === 'settings') await renderSettings();
    else await renderToday();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Something went wrong: ${esc(err.message)}</p>`;
  }
  if (screen !== 'log') window.scrollTo(0, 0);
}

document.addEventListener('click', e => {
  const replaceLink = e.target.closest('a[data-replace]');
  if (replaceLink) {
    e.preventDefault();
    location.replace(replaceLink.getAttribute('href'));
    return;
  }
  if (e.target.closest('[data-back]')) {
    if (history.length > 1) history.back();
    else location.replace('#/today');
  }
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Reload once when an updated worker takes over, so a new version shows right away.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service worker failed', err));
}

async function init() {
  plan = await (await fetch('./plan.json')).json();
  for (const [key, list] of Object.entries(plan.lists)) {
    for (const ex of list) {
      exercises.set(ex.id, ex);
      listOf.set(ex.id, key);
    }
  }
  settings = await loadSettings();
  navigator.storage?.persist?.().then(granted => setMeta('persistGranted', granted)).catch(() => {});

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    // Reopened on a new day: start fresh.
    if (document.visibilityState === 'visible' && renderedDate && renderedDate !== localDate()) route();
    updateWakeLock();
  });

  registerServiceWorker();
  await route();
  updateWakeLock();
}

init().catch(err => {
  app.innerHTML = `<p class="error">LiftLog couldn't start: ${esc(err.message)}</p>`;
});
