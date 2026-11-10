// LiftLog: hash router and screens (Today, Add exercise, Set Logger, History, Set Editor, Settings).

import { addSet, putSet, getSet, writeSets, setsByExercise, setsByDate, allSets, getMeta, setMeta, localDate } from './db.js';
import * as exp from './export.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const toastEl = document.getElementById('toast');

const DEFAULT_RIR = 2;
const BACKUP_WARN_DAYS = 7;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let plan;
const exercises = new Map(); // id -> exercise, every list, plan order
let settings;
let todayHasSets = false;
let renderedDate = null;
let wakeLock = null;
let toAssist = () => null;          // level -> assist lb (null when off chart), built from plan.assistChart
const variantChoice = new Map();    // exId -> variant key picked in the logger this session
const historyFilter = new Map();    // exId -> 'all' | variant key
let editor = null;                  // Set Editor state

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
const round2 = n => Math.round(n * 100) / 100;
const bySetNumber = (a, b) => a.setNumber - b.setNumber || a.createdAt.localeCompare(b.createdAt);
const newest = sets => sets.reduce((m, s) => (!m || s.date > m.date || (s.date === m.date && s.createdAt > m.createdAt) ? s : m), null);
const unitOf = s => s.unit ?? 'lb';

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${m}/${d}`;
}

const weekdayOf = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };
const daysSince = isoTimestamp => (isoTimestamp ? (Date.now() - Date.parse(isoTimestamp)) / 86400000 : Infinity);

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('show'), 2000);
}

function goBack(fallback) {
  if (history.length > 1) history.back();
  else location.replace(fallback);
}

// ---------- plan lookups ----------

const findVariant = (ex, key) => ex.variants?.find(v => v.key === key) ?? null;
// Sets saved before variants existed count as the exercise's first (planned) variant.
const variantKeyOf = (ex, s) => s.variant ?? ex.variants?.[0]?.key ?? null;
const prefKey = (ex, vkey) => `${ex.id}|${vkey ?? ''}`;
const planUnit = (ex, vkey) => findVariant(ex, vkey)?.unit ?? ex.unit ?? 'lb';
const unitFor = (ex, vkey) => settings.unitOverrides[prefKey(ex, vkey)] ?? planUnit(ex, vkey);

function listName(key) {
  return plan.days.find(d => d.list === key)?.label.split(': ')[1] ?? key[0].toUpperCase() + key.slice(1);
}
const listDays = key => plan.days.filter(d => d.list === key).map(d => d.label.split(':')[0]).join(', ');

function barWeightFor(ex, v) {
  const saved = settings.barWeights[prefKey(ex, v.key)];
  return { weight: saved ?? v.barWeight ?? 0, estimated: saved == null && v.barWeightConfirmed === false };
}

function stepFor(ex, v, unit) {
  if (unit === 'level') return 1;
  if (v?.step != null) return v.step;
  if (ex.step != null) return ex.step;
  return settings.steps[ex.equipment] ?? plan.defaults?.step?.[ex.equipment] ?? 5;
}

// Everything the weight field needs for one exercise + variant + unit.
function model(ex, vkey, unit) {
  const v = findVariant(ex, vkey);
  const perSideEntry = unit === 'lb' && !!v?.perSideEntry;
  return { ex, vkey, v, unit, perSideEntry, bar: perSideEntry ? barWeightFor(ex, v) : null, step: stepFor(ex, v, unit) };
}

// What the weight box shows for a stored set: per-side weight for barbell entry, else the stored weight.
const entryOf = (m, s) => (m.perSideEntry ? s.perSide ?? '' : s.weight);

const assistLbFor = (ex, unit, weight) => (!ex.assistChart ? null : unit === 'level' ? toAssist(weight) : weight);

// Comparable load for hints and charts: assist lb for assisted machines, else the stored weight.
function loadOf(ex, s) {
  if (ex.assistChart) return s.assistLb ?? (unitOf(s) === 'level' ? toAssist(s.weight) : s.weight);
  return s.weight;
}

function buildAssistConverter() {
  const chart = plan.assistChart;
  const m = chart?.formula?.match(/=\s*(-?[\d.]+)\s*\*\s*level\s*([+-])\s*([\d.]+)/);
  if (!m) return () => null;
  const a = Number(m[1]);
  const b = (m[2] === '-' ? -1 : 1) * Number(m[3]);
  return level => (level >= chart.minLevel && level <= chart.maxLevel ? round2(a * level + b) : null);
}

// ---------- formatting ----------

function fmtLoad(ex, s) {
  if (unitOf(s) === 'level') {
    const assist = ex?.assistChart ? s.assistLb ?? toAssist(s.weight) : null;
    return `L${num(s.weight)}${assist != null ? ` (${num(assist)} lb)` : ''}`;
  }
  if (ex?.bodyweight) return s.weight ? `BW+${num(s.weight)}` : 'BW';
  if (s.perSide != null) return `${num(s.weight)} (${num(s.perSide)}/side)`;
  return num(s.weight);
}

const fmtSet = (ex, s) => `${fmtLoad(ex, s)}×${s.reps}${s.rir == null ? '' : ` @${s.rir}`}`;

function targetText(ex) {
  if (!ex.sets) return '';
  const reps = ex.repMin == null ? 'max' : ex.repMin === ex.repMax ? ex.repMin : `${ex.repMin}–${ex.repMax}`;
  return `${ex.sets} × ${reps}`;
}

function metaText(ex, vkey) {
  const parts = [targetText(ex)];
  const v = findVariant(ex, vkey);
  if (v) parts.push(v.label);
  else if (ex.machine != null) parts.push(`Machine #${ex.machine}`);
  if (ex.perSide) parts.push('per side');
  if (ex.assisted) parts.push('assisted');
  return parts.filter(Boolean).join(' · ');
}

function lastText(ex, last) {
  if (!last) return '<div class="last muted">No history yet</div>';
  return `<div class="last"><span class="lbl">LAST TIME</span><b>${shortDate(last.date)}:</b> ${last.sets.map(s => fmtSet(ex, s)).join(', ')}</div>`;
}

// ---------- progression ----------

// Most recent date before today with sets of this variant.
function lastSession(ex, sets, today, vkey) {
  const pool = sets.filter(s => s.date < today && variantKeyOf(ex, s) === vkey);
  if (!pool.length) return null;
  const date = pool.reduce((m, s) => (s.date > m ? s.date : m), '');
  return { date, sets: pool.filter(s => s.date === date).sort(bySetNumber) };
}

// Working weight = heaviest load (lowest assist) last session. Judge only the sets at that load.
function progressionHint(ex, last) {
  if (!last || ex.repMin == null || ex.repMax == null) return null;
  const unit = unitOf(last.sets[last.sets.length - 1]);
  const sets = last.sets.filter(s => (ex.assistChart || unitOf(s) === unit) && loadOf(ex, s) != null);
  if (!sets.length) return null;
  const loads = sets.map(s => loadOf(ex, s));
  const working = ex.assisted ? Math.min(...loads) : Math.max(...loads);
  const top = sets.filter(s => loadOf(ex, s) === working);
  if (top.some(s => s.reps < ex.repMin)) return { text: 'Too heavy for range', cls: 'warn' };
  if (top.every(s => s.reps >= ex.repMax && s.rir != null && s.rir >= 1)) return { text: ex.assisted ? 'Reduce assist' : 'Add weight', cls: '' };
  return null;
}

const hintBadge = h => (h ? `<span class="badge ${h.cls}">${h.text}</span>` : '');

// ---------- data ----------

async function loadSettings() {
  const defaults = { keepAwake: true, steps: {}, unitOverrides: {}, barWeights: {} };
  for (const ex of exercises.values()) {
    const step = plan.defaults?.step?.[ex.equipment];
    if (step) defaults.steps[ex.equipment] = step;
  }
  const saved = (await getMeta('settings')) || {};
  return {
    ...defaults, ...saved,
    steps: { ...defaults.steps, ...saved.steps },
    unitOverrides: { ...saved.unitOverrides },
    barWeights: { ...saved.barWeights },
  };
}

const saveSettings = () => setMeta('settings', settings);
const exerciseSets = async exId => (await setsByExercise(exId)).filter(s => !s.demo);

// Variant the logger opens on: picked this session, else the last one used, else the first.
function defaultVariant(ex, sets) {
  if (!ex.variants) return null;
  const picked = variantChoice.get(ex.id);
  if (picked && findVariant(ex, picked)) return picked;
  const latest = newest(sets);
  return latest ? variantKeyOf(ex, latest) : ex.variants[0].key;
}

async function currentDayLabel(today, todaySets) {
  const choice = await getMeta('dayChoice');
  if (choice?.date === today && plan.days.some(d => d.label === choice.label)) return choice.label;
  const logged = todaySets[0]?.dayLabel;
  if (logged) return logged;
  return plan.days.find(d => d.weekday === new Date().getDay())?.label ?? null;
}

// Today's session = sets with today's date AND the selected day label. The working list is the
// day's planned exercises plus any other exercise with sets in this session (or opened via extraId).
async function loadToday(extraId) {
  const today = localDate();
  const allToday = (await setsByDate(today)).filter(s => !s.demo);
  todayHasSets = allToday.length > 0;
  renderedDate = today;
  const dayLabel = await currentDayLabel(today, allToday);
  const todaySets = allToday.filter(s => s.dayLabel === dayLabel);
  const day = plan.days.find(d => d.label === dayLabel);
  const planned = day ? plan.lists[day.list] : [];
  const plannedIds = new Set(planned.map(e => e.id));
  const counts = {};
  for (const s of todaySets) counts[s.exerciseId] = (counts[s.exerciseId] || 0) + 1;
  const added = [...exercises.values()].filter(e => !plannedIds.has(e.id) && (counts[e.id] || e.id === extraId));
  const weekdayDay = plan.days.find(d => d.weekday === new Date().getDay());
  const preview = !!weekdayDay && !!dayLabel && weekdayDay.label !== dayLabel;
  return { today, todaySets, dayLabel, planned, added, list: [...planned, ...added], counts, preview };
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

// Renumber one session's sets for an exercise as 1..n, keeping their order.
async function renumber(exId, date, dayLabel) {
  const sets = (await exerciseSets(exId)).filter(s => s.date === date && s.dayLabel === dayLabel).sort(bySetNumber);
  const changed = sets.map((s, i) => ({ ...s, setNumber: i + 1 })).filter((s, i) => s.setNumber !== sets[i].setNumber);
  if (changed.length) await writeSets({ put: changed });
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

// ---------- shared set fields (logger + editor) ----------

function weightLabel(m) {
  if (m.unit === 'level') return 'Level';
  if (m.perSideEntry) return 'Per side (lb)';
  if (m.ex.assisted) return 'Assist (lb)';
  if (m.ex.bodyweight) return 'Added weight (lb)';
  return 'Weight (lb)';
}

function weightSub(m) {
  return [
    m.ex.perSide && 'per side',
    m.ex.assisted && (m.unit === 'level' ? 'higher = more help' : 'lower = stronger'),
    m.ex.bodyweight && m.unit === 'lb' && '0 = bodyweight',
  ].filter(Boolean).join(' · ');
}

function derivedText(m, entry) {
  const val = parseFloat(entry);
  if (m.perSideEntry) {
    const total = Number.isFinite(val) ? num(m.bar.weight + 2 * val) : '–';
    return `Total ${total} lb · bar ${num(m.bar.weight)}${m.bar.estimated ? ' (bar weight estimated)' : ''}`;
  }
  if (m.ex.assistChart && m.unit === 'level' && Number.isFinite(val)) {
    const assist = toAssist(val);
    return assist == null ? `Off chart (levels ${plan.assistChart.minLevel}–${plan.assistChart.maxLevel})` : `= ${num(assist)} lb assist`;
  }
  return '';
}

function variantChips(ex, vkey) {
  if (!ex.variants) return '';
  return `<div class="variants">${ex.variants.map(v =>
    `<button type="button" class="chip${v.key === vkey ? ' active' : ''}" data-variant="${esc(v.key)}">${esc(v.label)}</button>`).join('')}</div>`;
}

function unitToggle(unit) {
  return `<span class="unit-toggle" role="group" aria-label="Unit">${['lb', 'level'].map(u =>
    `<button type="button" data-unit="${u}" class="${u === unit ? 'on' : ''}" aria-pressed="${u === unit}">${u}</button>`).join('')}</span>`;
}

function fieldsHtml(m, vals) {
  const sub = weightSub(m);
  const label = weightLabel(m);
  return `
    <div class="field-label"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}${unitToggle(m.unit)}</div>
    ${m.unit === 'level' && plan.units?.level ? `<p class="help">${esc(plan.units.level)}</p>` : ''}
    <div class="stepper${m.step ? '' : ' single'}">
      ${m.step ? '<button type="button" data-step="weight" data-dir="-1" aria-label="Less">−</button>' : ''}
      <input name="weight" inputmode="decimal" value="${esc(vals.entry === '' || vals.entry == null ? '' : num(Number(vals.entry)))}" aria-label="${label}">
      ${m.step ? '<button type="button" data-step="weight" data-dir="1" aria-label="More">+</button>' : ''}
    </div>
    <p class="derived" data-derived>${esc(derivedText(m, vals.entry))}</p>

    <div class="field-label"><span>Reps</span>${m.ex.repMin != null ? `<small>target ${m.ex.repMin === m.ex.repMax ? m.ex.repMin : `${m.ex.repMin}–${m.ex.repMax}`}</small>` : ''}</div>
    <div class="stepper">
      <button type="button" data-step="reps" data-dir="-1" aria-label="Fewer reps">−</button>
      <input name="reps" inputmode="numeric" pattern="[0-9]*" value="${esc(vals.reps ?? '')}" placeholder="${esc(vals.repsPlaceholder ?? '')}" aria-label="Reps">
      <button type="button" data-step="reps" data-dir="1" aria-label="More reps">+</button>
    </div>

    <div class="field-label"><span>RIR</span><small>reps in reserve</small></div>
    <div class="rir">
      ${[0, 1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rir" value="${n}"${String(n) === String(vals.rir) ? ' checked' : ''}><span>${n}</span></label>`).join('')}
    </div>

    <input class="notes" name="notes" maxlength="120" placeholder="Notes (optional)" value="${esc(vals.notes ?? '')}">
    <p class="error" hidden></p>`;
}

function bindFields(form, m) {
  const weight = form.elements.weight;
  const derived = form.querySelector('[data-derived]');
  const refresh = () => { derived.textContent = derivedText(m, weight.value); };
  weight.addEventListener('input', refresh);
  form.querySelectorAll('[data-step]').forEach(btn => {
    btn.onclick = () => {
      const input = form.elements[btn.dataset.step];
      const delta = (btn.dataset.step === 'weight' ? m.step : 1) * Number(btn.dataset.dir);
      // Empty reps + tap: start from last time's reps (the placeholder).
      const base = parseFloat(input.value) || (btn.dataset.step === 'reps' && input.placeholder ? Number(input.placeholder) - delta : 0);
      input.value = num(Math.max(0, round2(base + delta)));
      refresh();
    };
  });
}

function readFields(form, m) {
  const entry = parseFloat(form.elements.weight.value);
  const reps = Number(form.elements.reps.value);
  if (!Number.isFinite(entry) || entry < 0) return { error: m.unit === 'level' ? 'Enter a level.' : 'Enter a weight.' };
  if (!Number.isInteger(reps) || reps < 1) return { error: 'Enter reps.' };
  const rir = form.elements.rir.value;
  const weight = round2(m.perSideEntry ? m.bar.weight + 2 * entry : entry);
  return {
    fields: {
      weight,
      perSide: m.perSideEntry ? entry : null,
      unit: m.unit,
      variant: m.ex.variants ? m.vkey : null,
      assistLb: assistLbFor(m.ex, m.unit, weight),
      reps,
      rir: rir === '' ? null : Number(rir),
      notes: form.elements.notes.value.trim(),
    },
  };
}

function showFormError(form, msg) {
  const error = form.querySelector('.error');
  error.textContent = msg;
  error.hidden = false;
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

function card(ex, ctx, info) {
  const c = ctx.counts[ex.id] || 0;
  const done = c >= ex.sets;
  return `
    <a class="card${done ? ' done' : ''}" href="#/log/${ex.id}">
      <div class="card-head">
        <span class="slot">${esc(ex.slot)}</span>
        <span class="name">${esc(ex.name)}</span>
        <span class="count">${done ? '✓ ' : ''}${c}/${ex.sets}</span>
      </div>
      <div class="meta">${esc(metaText(ex, info.vkey))}</div>
      ${ex.note ? `<div class="note">${esc(ex.note)}</div>` : ''}
      ${lastText(ex, info.last)}
      ${hintBadge(progressionHint(ex, info.last))}
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

  const info = Object.fromEntries(await Promise.all(ctx.list.map(async ex => {
    const sets = await exerciseSets(ex.id);
    const vkey = defaultVariant(ex, sets);
    return [ex.id, { vkey, last: lastSession(ex, sets, ctx.today, vkey) }];
  })));
  const { done, total } = progress(ctx);
  const pct = total ? Math.round((done / total) * 100) : 0;

  let nudge = '';
  if (total && done >= total) {
    const lastBackup = await getMeta('lastBackup');
    if (daysSince(lastBackup) > BACKUP_WARN_DAYS) {
      nudge = `<a class="banner" href="#/settings" data-replace>All sets done. Back up now — last backup: ${lastBackup ? shortDate(localDate(new Date(lastBackup))) : 'never'}</a>`;
    }
  }

  const preview = ctx.preview
    ? `<div class="banner preview"><b>Preview: ${esc(ctx.dayLabel)}</b><br>Sets you log now are saved as ${shortDate(ctx.today)}, ${esc(ctx.dayLabel)}.</div>`
    : '';

  const groupsHtml = groupBySuperset(ctx.planned).map(g => `
    <h2>${g.items.length > 1 ? `Superset ${esc(g.key)}` : esc(g.key)}</h2>
    ${g.items.map(ex => card(ex, ctx, info[ex.id])).join('')}`).join('');

  const addedHtml = ctx.added.length
    ? `<h2>Added today</h2>${ctx.added.map(ex => card(ex, ctx, info[ex.id])).join('')}`
    : '';

  app.innerHTML = `
    <header class="top">
      <h1>${shortDate(ctx.today)}</h1>
      <select id="day" aria-label="Workout day">
        ${plan.days.map(d => `<option${d.label === ctx.dayLabel ? ' selected' : ''}>${esc(d.label)}</option>`).join('')}
      </select>
    </header>
    ${preview}
    <div class="progress">
      <div class="progress-text">${done} of ${total} sets</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>
    ${nudge}
    ${groupsHtml}
    ${addedHtml}
    <a class="button add-btn" href="#/add">+ Add exercise</a>`;

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

// ---------- Add exercise ----------

async function renderAdd() {
  const ctx = await loadToday();
  if (!ctx.dayLabel) return location.replace('#/today');
  const onList = new Set(ctx.planned.map(e => e.id));
  const groups = Object.entries(plan.lists).map(([key, list]) => {
    const items = list.filter(ex => !onList.has(ex.id));
    if (!items.length) return '';
    const days = listDays(key);
    return `
      <h2>${esc(listName(key))}${days ? ` · ${esc(days)}` : ''}</h2>
      <div class="panel list">
        ${items.map(ex => `
          <a class="list-item" href="#/log/${ex.id}" data-replace>
            <span>${esc(ex.name)}</span>
            <small class="muted">${ctx.counts[ex.id] ? `${ctx.counts[ex.id]} today` : esc(ex.slot)}</small>
          </a>`).join('')}
      </div>`;
  }).join('');

  app.innerHTML = `
    <div class="lg-top">
      <button type="button" class="back" data-back="#/today">‹ Today</button>
      <span class="muted">${esc(ctx.dayLabel)}</span>
    </div>
    <h1>Add exercise</h1>
    <p class="muted small">Sets are saved under today's day: ${esc(ctx.dayLabel)}.</p>
    ${groups}`;
}

// ---------- Set Logger ----------

async function renderLogger(exId, editId) {
  const ex = exercises.get(exId);
  if (!ex) return location.replace('#/today');
  const ctx = await loadToday(exId);
  if (!ctx.dayLabel) return location.replace('#/today');

  const sets = await exerciseSets(exId);
  const mine = ctx.todaySets.filter(s => s.exerciseId === exId).sort(bySetNumber);
  const editing = editId ? mine.find(s => s.id === editId) : null;
  const vkey = editing ? variantKeyOf(ex, editing) : defaultVariant(ex, sets);
  const unit = editing ? unitOf(editing) : unitFor(ex, vkey);
  const m = model(ex, vkey, unit);
  const last = lastSession(ex, sets, ctx.today, vkey);
  const setNum = editing ? editing.setNumber : mine.length + 1;

  // "Last time, set N" pairs by position among this variant's sets.
  const variantToday = mine.filter(s => variantKeyOf(ex, s) === vkey);
  const position = editing ? variantToday.indexOf(editing) : variantToday.length;
  const lastMatch = last?.sets[position];
  const sameUnit = s => unitOf(s) === unit;
  const prior = [...variantToday].reverse().find(sameUnit) ?? [...(last?.sets ?? [])].reverse().find(sameUnit);
  const entry = editing ? entryOf(m, editing) : prior ? entryOf(m, prior) : ex.bodyweight ? 0 : '';

  const idx = ctx.list.findIndex(e => e.id === exId);
  const prev = ctx.list[idx - 1];
  const next = ctx.list[idx + 1];

  const chips = ctx.list.map(e => {
    const c = ctx.counts[e.id] || 0;
    return `<button type="button" class="chip${e.id === exId ? ' active' : ''}${c >= e.sets ? ' done' : ''}" data-ex="${e.id}">${esc(e.name)} <b>${c}/${e.sets}</b></button>`;
  }).join('');

  const rows = mine.map(s => {
    const extra = [ex.variants && findVariant(ex, variantKeyOf(ex, s))?.label, s.notes].filter(Boolean).join(' · ');
    return `
      <div class="set-row${editing?.id === s.id ? ' editing' : ''}">
        <span class="n">Set ${s.setNumber}</span>
        <span class="v">${fmtSet(ex, s)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>
        <button type="button" data-edit="${s.id}" aria-label="Edit set ${s.setNumber}">Edit</button>
        <button type="button" data-del="${s.id}" aria-label="Delete set ${s.setNumber}">✕</button>
      </div>`;
  }).join('');

  app.innerHTML = `
    <div class="lg-top">
      <button type="button" class="back" data-back="#/today">‹ Today</button>
      <span class="muted">${esc(ctx.dayLabel)}</span>
    </div>
    <div class="strip">${chips}</div>
    <section class="ex-head">
      <div class="title"><span class="slot">${esc(ex.slot)}</span><h1>${esc(ex.name)}</h1></div>
      ${editing ? '' : variantChips(ex, vkey)}
      <div class="meta">${esc(metaText(ex, vkey))}</div>
      ${ex.note ? `<div class="note">${esc(ex.note)}</div>` : ''}
      ${m.v?.note ? `<div class="note">${esc(m.v.note)}</div>` : ''}
      ${hintBadge(progressionHint(ex, last))}
      ${lastText(ex, last)}
    </section>
    ${lastMatch ? `<div class="lastset">Last time, set ${position + 1}: ${fmtSet(ex, lastMatch)}</div>` : ''}

    <form id="setform" autocomplete="off" novalidate>
      ${fieldsHtml(m, { entry, reps: editing?.reps ?? '', rir: editing ? editing.rir : DEFAULT_RIR, notes: editing?.notes ?? '', repsPlaceholder: lastMatch?.reps ?? '' })}
      ${editing ? '<button type="button" class="cancel" data-cancel>Cancel edit</button>' : ''}
    </form>

    ${mine.length ? `<h2>Today</h2>${rows}` : ''}

    <div class="actionbar">
      <button type="button" data-go="${prev?.id ?? ''}" aria-label="Previous exercise"${prev ? '' : ' disabled'}>‹</button>
      <button type="submit" form="setform" class="primary">${editing ? 'Save' : 'Log'} set ${setNum}</button>
      <button type="button" data-go="${next?.id ?? ''}" aria-label="Next exercise"${next ? '' : ' disabled'}>›</button>
    </div>`;

  app.querySelector('.strip .chip.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const form = app.querySelector('#setform');
  bindFields(form, m);

  form.onsubmit = async e => {
    e.preventDefault();
    const r = readFields(form, m);
    if (r.error) return showFormError(form, r.error);
    if (editing) {
      await putSet({ ...editing, ...r.fields });
      toast(`Set ${setNum} saved`);
    } else {
      await addSet({
        id: crypto.randomUUID(),
        date: ctx.today,
        dayLabel: ctx.dayLabel,
        exerciseId: ex.id,
        exerciseName: ex.name,
        setNumber: setNum,
        ...r.fields,
        createdAt: new Date().toISOString(),
      });
      toast(`Set ${setNum} logged`);
    }
    todayHasSets = true;
    updateWakeLock();
    renderLogger(exId);
  };

  app.querySelectorAll('[data-variant]').forEach(btn => {
    btn.onclick = () => { variantChoice.set(exId, btn.dataset.variant); renderLogger(exId); };
  });
  app.querySelectorAll('[data-unit]').forEach(btn => {
    btn.onclick = async () => {
      if (editing) return showFormError(form, 'Change the unit of a logged set in History.');
      const key = prefKey(ex, vkey);
      if (btn.dataset.unit === planUnit(ex, vkey)) delete settings.unitOverrides[key];
      else settings.unitOverrides[key] = btn.dataset.unit;
      await saveSettings();
      renderLogger(exId);
    };
  });
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
      await writeSets({ del: [set.id] });
      await renumber(exId, set.date, set.dayLabel);
      toast('Set deleted');
      renderLogger(exId);
    };
  });
}

// ---------- History ----------

// Exercise ids in the data but no longer in plan.json still get a read/edit view.
function orphanExercise(exId, sets) {
  const latest = newest(sets);
  return latest ? { id: exId, name: latest.exerciseName, slot: '', sets: 0, repMin: null, repMax: null, unit: 'lb', note: '' } : null;
}

async function renderHistoryIndex() {
  const all = (await allSets()).filter(s => !s.demo);
  const stats = new Map();
  for (const s of all) {
    const st = stats.get(s.exerciseId) ?? { dates: new Set(), last: '', name: s.exerciseName };
    st.dates.add(s.date);
    if (s.date > st.last) st.last = s.date;
    stats.set(s.exerciseId, st);
  }
  const item = (id, name) => {
    const st = stats.get(id);
    return `
      <a class="list-item" href="#/history/${id}">
        <span>${esc(name)}</span>
        <small class="muted">${st ? `${st.dates.size} session${st.dates.size === 1 ? '' : 's'} · ${shortDate(st.last)}` : 'No sets yet'}</small>
      </a>`;
  };
  const groups = Object.entries(plan.lists).map(([key, list]) => {
    const days = listDays(key);
    return `<h2>${esc(listName(key))}${days ? ` · ${esc(days)}` : ''}</h2>
      <div class="panel list">${list.map(ex => item(ex.id, ex.name)).join('')}</div>`;
  }).join('');
  const orphans = [...stats.keys()].filter(id => !exercises.has(id));
  const orphanHtml = orphans.length
    ? `<h2>Not in current plan</h2><div class="panel list">${orphans.map(id => item(id, stats.get(id).name)).join('')}</div>`
    : '';

  app.innerHTML = `<header class="top"><h1>History</h1></header>${groups}${orphanHtml}`;
}

function chartSeries(ex, sets) {
  const latest = newest(sets);
  if (!latest) return null;
  const unit = unitOf(latest);
  const pool = ex.assistChart || ex.bodyweight ? sets : sets.filter(s => unitOf(s) === unit);
  let label, lowerIsBetter = false, value;
  if (ex.bodyweight) {
    label = 'Most reps';
    value = ss => Math.max(...ss.map(s => s.reps));
  } else if (ex.assisted) {
    label = ex.assistChart ? 'Assist (lb), lower is better' : `Assist (${unit}), lower is better`;
    lowerIsBetter = true;
    value = ss => { const v = ss.map(s => loadOf(ex, s)).filter(x => x != null); return v.length ? Math.min(...v) : null; };
  } else if (unit === 'level') {
    label = 'Top level';
    value = ss => Math.max(...ss.map(s => s.weight));
  } else {
    label = 'Best estimated 1RM (lb)';
    value = ss => Math.round(Math.max(...ss.map(s => s.weight * (1 + s.reps / 30))) * 10) / 10;
  }
  const byDate = new Map();
  for (const s of pool) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  const points = [...byDate.keys()].sort().map(date => ({ date, value: value(byDate.get(date)) })).filter(p => p.value != null);
  return { label, lowerIsBetter, points, onlyUnit: pool.length < sets.length ? unit : null };
}

function chartHtml(series) {
  if (!series?.points.length) return '';
  const { points } = series;
  const W = 340, H = 150, L = 40, R = 12, T = 12, B = 24;
  const vals = points.map(p => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const x = i => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1));
  const y = v => T + ((max - v) * (H - T - B)) / (max - min);
  const md = iso => iso.slice(5).replace('-', '/').replace(/^0/, '').replace('/0', '/');
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

  let change = '';
  if (points.length > 1 && points[0].value !== 0) {
    const pct = ((points[points.length - 1].value - points[0].value) / points[0].value) * 100;
    const better = series.lowerIsBetter ? pct < 0 : pct > 0;
    const cls = pct === 0 ? '' : better ? 'good' : 'warn';
    change = `<p class="change ${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}% since ${md(points[0].date)}${series.lowerIsBetter ? ' (lower is better)' : ''}</p>`;
  }

  return `
    <div class="panel chart">
      <div class="chart-label">${esc(series.label)}${series.onlyUnit ? ` · ${series.onlyUnit} sets only` : ''}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.label)}">
        <line class="grid" x1="${L}" x2="${W - R}" y1="${y(max)}" y2="${y(max)}"/>
        <line class="grid" x1="${L}" x2="${W - R}" y1="${y(min)}" y2="${y(min)}"/>
        <text class="axis" x="${L - 6}" y="${y(max) + 4}" text-anchor="end">${num(round2(max))}</text>
        <text class="axis" x="${L - 6}" y="${y(min) + 4}" text-anchor="end">${num(round2(min))}</text>
        <text class="axis" x="${x(0)}" y="${H - 6}" text-anchor="${points.length === 1 ? 'middle' : 'start'}">${md(points[0].date)}</text>
        ${points.length > 1 ? `<text class="axis" x="${x(points.length - 1)}" y="${H - 6}" text-anchor="end">${md(points[points.length - 1].date)}</text>` : ''}
        ${points.length > 1 ? `<polyline class="line" points="${line}"/>` : ''}
        ${points.map((p, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="4"><title>${md(p.date)}: ${num(p.value)}</title></circle>`).join('')}
      </svg>
      ${change}
    </div>`;
}

async function renderHistory(exId) {
  const sets = await exerciseSets(exId);
  const ex = exercises.get(exId) ?? orphanExercise(exId, sets);
  if (!ex) return location.replace('#/history');
  const filter = ex.variants ? historyFilter.get(exId) ?? 'all' : 'all';
  const shown = filter === 'all' ? sets : sets.filter(s => variantKeyOf(ex, s) === filter);

  const sessions = new Map();
  for (const s of shown) {
    const key = `${s.date}|${s.dayLabel}`;
    sessions.set(key, [...(sessions.get(key) ?? []), s]);
  }
  const ordered = [...sessions.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const filterChips = ex.variants
    ? `<div class="variants">${[{ key: 'all', label: 'All' }, ...ex.variants].map(v =>
      `<button type="button" class="chip${v.key === filter ? ' active' : ''}" data-filter="${esc(v.key)}">${esc(v.label)}</button>`).join('')}</div>`
    : '';

  const sessionHtml = ordered.map(([key, ss]) => {
    const [date, dayLabel] = [key.slice(0, 10), key.slice(11)];
    return `
      <div class="session">
        <div class="session-head"><b>${shortDate(date)}</b><span class="muted">${esc(dayLabel)}</span></div>
        ${ss.sort(bySetNumber).map(s => {
          const extra = [ex.variants && findVariant(ex, variantKeyOf(ex, s))?.label, s.notes].filter(Boolean).join(' · ');
          return `
            <div class="set-row">
              <span class="n">Set ${s.setNumber}</span>
              <span class="v">${fmtSet(ex, s)}${extra ? `<small>${esc(extra)}</small>` : ''}</span>
              <a class="button" href="#/set/${s.id}" aria-label="Edit set ${s.setNumber}">Edit</a>
              <button type="button" data-del="${s.id}" aria-label="Delete set ${s.setNumber}">✕</button>
            </div>`;
        }).join('')}
        <a class="add-set" href="#/set/new/${exId}/${date}/${encodeURIComponent(dayLabel)}">+ Add set to this session</a>
      </div>`;
  }).join('');

  app.innerHTML = `
    <div class="lg-top">
      <button type="button" class="back" data-back="#/history">‹ History</button>
    </div>
    <section class="ex-head">
      <div class="title">${ex.slot ? `<span class="slot">${esc(ex.slot)}</span>` : ''}<h1>${esc(ex.name)}</h1></div>
      <div class="meta">${esc(metaText(ex, null))}</div>
    </section>
    ${filterChips}
    ${chartHtml(chartSeries(ex, shown))}
    <div class="row"><a class="button" href="#/set/new/${exId}">+ Add past set</a></div>
    ${sessionHtml || '<p class="muted">No sets yet.</p>'}`;

  app.querySelectorAll('[data-filter]').forEach(btn => {
    btn.onclick = () => { historyFilter.set(exId, btn.dataset.filter); renderHistory(exId); };
  });
  app.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      const set = sets.find(s => s.id === btn.dataset.del);
      if (!confirm(`Delete ${shortDate(set.date)} set ${set.setNumber} (${fmtSet(ex, set)})?`)) return;
      await writeSets({ del: [set.id] });
      await renumber(exId, set.date, set.dayLabel);
      toast('Set deleted');
      renderHistory(exId);
    };
  });
}

// ---------- Set Editor (History edit / add past set) ----------

function dayForDate(date, sets) {
  return sets.find(s => s.date === date)?.dayLabel
    ?? plan.days.find(d => d.weekday === weekdayOf(date))?.label
    ?? plan.days[0].label;
}

async function initEditor(parts) {
  const route = location.hash;
  if (parts[1] === 'new') {
    const exId = parts[2];
    const sets = await exerciseSets(exId);
    const ex = exercises.get(exId) ?? orphanExercise(exId, sets);
    if (!ex) return null;
    const all = (await allSets()).filter(s => !s.demo);
    const today = localDate();
    const lastGymDate = all.reduce((m, s) => (s.date > m && s.date <= today ? s.date : m), '');
    const date = parts[3] || lastGymDate || today;
    const vkey = defaultVariant(ex, sets);
    return {
      route, mode: 'new', ex, exId, date,
      dayLabel: parts[4] || dayForDate(date, all), dayTouched: !!parts[4],
      vkey, unit: unitFor(ex, vkey), entry: '', reps: '', rir: DEFAULT_RIR, notes: '', allSets: all,
    };
  }
  const set = await getSet(parts[1]);
  if (!set) return null;
  const ex = exercises.get(set.exerciseId) ?? orphanExercise(set.exerciseId, [set]);
  const vkey = variantKeyOf(ex, set);
  const unit = unitOf(set);
  return {
    route, mode: 'edit', set, ex, exId: set.exerciseId, date: set.date, dayLabel: set.dayLabel, dayTouched: true,
    vkey, unit, entry: entryOf(model(ex, vkey, unit), set), reps: set.reps, rir: set.rir, notes: set.notes ?? '', allSets: null,
  };
}

async function renderSetEditor(parts) {
  if (!editor || editor.route !== location.hash) editor = await initEditor(parts);
  if (!editor) return location.replace('#/history');
  const st = editor;
  const { ex } = st;
  const m = model(ex, st.vkey, st.unit);
  const dayOptions = plan.days.map(d => d.label);
  if (!dayOptions.includes(st.dayLabel)) dayOptions.push(st.dayLabel);

  app.innerHTML = `
    <div class="lg-top">
      <button type="button" class="back" data-back="#/history/${st.exId}">‹ Cancel</button>
      <span class="muted">${st.mode === 'edit' ? `Edit set ${st.set.setNumber}` : 'Add past set'}</span>
    </div>
    <section class="ex-head">
      <div class="title">${ex.slot ? `<span class="slot">${esc(ex.slot)}</span>` : ''}<h1>${esc(ex.name)}</h1></div>
      ${variantChips(ex, st.vkey)}
    </section>
    <form id="setform" autocomplete="off" novalidate>
      <div class="two">
        <label><span class="field-label">Date</span><input type="date" name="date" value="${esc(st.date)}" max="${localDate()}" required></label>
        <label><span class="field-label">Day</span><select name="day">${dayOptions.map(l => `<option${l === st.dayLabel ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      </div>
      ${fieldsHtml(m, { entry: st.entry, reps: st.reps, rir: st.rir, notes: st.notes })}
      ${st.mode === 'edit' ? '<button type="button" class="cancel danger" data-delete>Delete this set</button>' : ''}
    </form>
    <div class="actionbar two">
      <button type="button" data-back="#/history/${st.exId}">Cancel</button>
      <button type="submit" form="setform" class="primary">${st.mode === 'edit' ? 'Save' : 'Add set'}</button>
    </div>`;

  const form = app.querySelector('#setform');
  bindFields(form, m);

  const capture = () => {
    st.date = form.elements.date.value;
    st.dayLabel = form.elements.day.value;
    st.entry = form.elements.weight.value;
    st.reps = form.elements.reps.value;
    st.rir = form.elements.rir.value;
    st.notes = form.elements.notes.value;
  };

  app.querySelectorAll('[data-variant]').forEach(btn => {
    btn.onclick = () => {
      capture();
      st.vkey = btn.dataset.variant;
      st.unit = unitFor(ex, st.vkey);
      st.entry = '';
      renderSetEditor(parts);
    };
  });
  app.querySelectorAll('[data-unit]').forEach(btn => {
    btn.onclick = () => { capture(); st.unit = btn.dataset.unit; renderSetEditor(parts); };
  });
  form.elements.day.onchange = () => { st.dayTouched = true; };
  form.elements.date.onchange = () => {
    capture();
    if (!st.dayTouched && st.date) {
      st.dayLabel = dayForDate(st.date, st.allSets ?? []);
      renderSetEditor(parts);
    }
  };

  form.onsubmit = async e => {
    e.preventDefault();
    capture();
    if (!st.date) return showFormError(form, 'Pick a date.');
    const r = readFields(form, m);
    if (r.error) return showFormError(form, r.error);

    if (st.mode === 'edit') {
      const old = st.set;
      const moved = old.date !== st.date || old.dayLabel !== st.dayLabel;
      // A set moved to another session goes to the end of it; both sessions are renumbered.
      await putSet({ ...old, ...r.fields, date: st.date, dayLabel: st.dayLabel, setNumber: moved ? 9999 : old.setNumber });
      if (moved) {
        await renumber(st.exId, old.date, old.dayLabel);
        await renumber(st.exId, st.date, st.dayLabel);
      }
      toast('Set saved');
    } else {
      const sessionCount = (await exerciseSets(st.exId)).filter(s => s.date === st.date && s.dayLabel === st.dayLabel).length;
      await addSet({
        id: crypto.randomUUID(),
        date: st.date,
        dayLabel: st.dayLabel,
        exerciseId: st.exId,
        exerciseName: ex.name,
        setNumber: sessionCount + 1,
        ...r.fields,
        createdAt: new Date().toISOString(),
      });
      toast(`Added to ${shortDate(st.date)}`);
    }
    editor = null;
    goBack(`#/history/${st.exId}`);
  };

  app.querySelector('[data-delete]')?.addEventListener('click', async () => {
    const set = st.set;
    if (!confirm(`Delete ${shortDate(set.date)} set ${set.setNumber} (${fmtSet(ex, set)})?`)) return;
    await writeSets({ del: [set.id] });
    await renumber(st.exId, set.date, set.dayLabel);
    editor = null;
    toast('Set deleted');
    goBack(`#/history/${st.exId}`);
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
  const canShareBackup = exp.canShareFiles('x.txt', 'text/plain');
  const equipment = Object.keys(settings.steps);
  const bars = [...exercises.values()].flatMap(ex => (ex.variants ?? []).filter(v => v.barWeight != null).map(v => ({ ex, v })));

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
      <p class="muted small">Columns 1–8 match the Log tab. Variant, Unit and Assist (lb) follow.</p>
    </div>

    <h2>Backup</h2>
    <div class="panel">
      <p class="${backupOld ? 'warn' : 'muted'}">Last backup: ${lastBackup ? shortDate(localDate(new Date(lastBackup))) : 'never'}${backupOld ? ' — back up soon' : ''}</p>
      <div class="row">
        <button type="button" id="json-dl">Download</button>
        ${canShareBackup ? '<button type="button" id="json-share">Share</button>' : ''}
      </div>
      <div class="row">
        <label class="button">Restore from backup<input type="file" id="json-in" accept=".json,.txt,application/json,text/plain" hidden></label>
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

    ${bars.length ? `
    <h2>Bar weights (lb)</h2>
    <div class="panel">
      ${bars.map(({ ex, v }) => {
        const b = barWeightFor(ex, v);
        return `<label class="bar-row"><span>${esc(ex.name)} · ${esc(v.label)}${b.estimated ? ' <small class="warn">estimated</small>' : ''}</span>
          <input inputmode="decimal" data-bar="${esc(prefKey(ex, v.key))}" value="${num(b.weight)}"></label>`;
      }).join('')}
    </div>` : ''}

    <h2>Storage</h2>
    <div class="panel">
      <p>${persisted ? 'Protected: the phone will not clear your data to free space.' : 'Not protected yet. Installing the app to the home screen usually fixes this.'}</p>
      ${persisted ? '' : '<div class="row"><button type="button" id="persist">Ask again</button></div>'}
    </div>

    <p class="muted small version">LiftLog ${esc(version)}</p>`;

  const range = () => app.querySelector('[name=range]:checked').value;

  // Share, or download; a refused share falls back to a download. Returns false if cancelled.
  async function deliver(file, share) {
    if (!share) {
      exp.downloadFile(file);
      return true;
    }
    const result = await exp.shareFile(file);
    if (result === 'downloaded') alert(`Sharing wasn't allowed, so ${file.name} was saved to Downloads instead.`);
    return result !== 'cancelled';
  }

  async function exportCsv(share) {
    const sets = await exp.setsForExport(range());
    if (!sets.length) return toast('No new sets to export');
    if (!(await deliver(exp.csvFile(sets, exercises), share))) return;
    await exp.markExported(sets);
    toast(`Exported ${sets.length} sets`);
    renderSettings();
  }

  async function exportJson(share) {
    if (!(await deliver(await exp.backupFile({ forShare: share }), share))) return;
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

  // Saving a bar weight confirms it, so "estimated" goes away.
  app.querySelectorAll('[data-bar]').forEach(input => {
    input.onchange = async () => {
      const v = parseFloat(input.value);
      if (!(v >= 0)) { renderSettings(); return; }
      settings.barWeights[input.dataset.bar] = v;
      await saveSettings();
      toast('Bar weight saved');
      renderSettings();
    };
  });

  app.querySelector('#persist')?.addEventListener('click', async () => {
    await navigator.storage?.persist?.();
    renderSettings();
  });
}

// ---------- router ----------

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const [screen, arg] = parts;
  document.body.classList.toggle('logging', screen === 'log' || screen === 'set');
  const tab = screen === 'settings' ? 'settings' : screen === 'history' || screen === 'set' ? 'history' : 'today';
  nav.querySelectorAll('[data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  if (screen !== 'set') editor = null;
  try {
    if (screen === 'log' && arg) await renderLogger(arg);
    else if (screen === 'add') await renderAdd();
    else if (screen === 'history' && arg) await renderHistory(arg);
    else if (screen === 'history') await renderHistoryIndex();
    else if (screen === 'set' && arg) await renderSetEditor(parts);
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
  const back = e.target.closest('[data-back]');
  if (back) goBack(back.dataset.back || '#/today');
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
  for (const list of Object.values(plan.lists)) {
    for (const ex of list) exercises.set(ex.id, ex);
  }
  toAssist = buildAssistConverter();
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
