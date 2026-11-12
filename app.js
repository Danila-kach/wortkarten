'use strict';

// ---------- Spaced repetition rules ----------
// A word needs 6 correct answers in a row: the first time it is shown, then after
// 1, 3, 7, 14 and 30 days. `stage` counts those correct answers; any mistake
// drops it back to stage 0 and shows it again tomorrow.
const INTERVALS = [1, 3, 7, 14, 30];
const LEARNED = INTERVALS.length + 1;
const MAX_ATTEMPTS = 2;
const STORE_KEY = 'wortkarten.v1';
const DEFAULT_SETTINGS = { setSize: 15, newPerDay: 10, autoSpeak: true };

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const ICONS = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
};

// ---------- Storage ----------
let db = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY));
    if (raw && Array.isArray(raw.words)) return fromData(raw);
  } catch (e) { /* fall through to an empty store */ }
  return fromData({});
}

function fromData(d) {
  return {
    words: d.words || [],
    tombstones: d.tombstones || {}, // deleted word id → time, so sync doesn't bring it back
    settings: { ...DEFAULT_SETTINGS, ...d.settings },
    settingsUpdated: d.settingsUpdated || 0,
    history: d.history || {},
  };
}

function writeLocal() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
  catch (e) { toast('Could not save: ' + e.message); }
}

function save() {
  writeLocal();
  scheduleSync();
}

function removeWords(ids) {
  const now = Date.now();
  const gone = new Set(ids);
  for (const id of gone) db.tombstones[id] = now;
  db.words = db.words.filter((w) => !gone.has(w.id));
}

// ---------- Helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const nav = $('#nav');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() { return dateStr(new Date()); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); }
function daysUntil(s) {
  const [y, m, d] = s.split('-').map(Number);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - now) / 86400000);
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const days = (n) => plural(n, 'day');
const wordsN = (n) => plural(n, 'word');

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Pronunciation: Google Translate's voice (the built-in iOS German voice sounded bad).
// Needs internet; offline it stays silent. One reused <audio> element keeps iOS happy.
let ttsAudio = null;
function speak(text) {
  const q = String(text).split(';')[0].replace(/[()]/g, '').trim();
  if (!q) return;
  try {
    ttsAudio = ttsAudio || new Audio();
    ttsAudio.pause();
    ttsAudio.src = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=de&q=${encodeURIComponent(q)}`;
    ttsAudio.play().catch(() => {});
  } catch (e) { /* no audio */ }
}

// ---------- Words ----------
function newWord(de, en) {
  const now = Date.now();
  return { id: uid(), de, en, stage: 0, due: today(), reviews: 0, correct: 0, wrong: 0, added: now, updated: now, firstSeen: null, lastSeen: null };
}

function status(w) {
  if (w.stage >= LEARNED) return 'learned';
  if (w.reviews === 0) return 'new';
  return 'learning';
}

function stageLabel(w) {
  const s = status(w);
  if (s === 'learned') return 'learned';
  if (s === 'new') return 'new';
  const d = daysUntil(w.due);
  const when = d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${days(d)}`;
  return `${w.stage}/${LEARNED} · ${when}`;
}

function badgeClass(w) {
  const s = status(w);
  if (s === 'learning' && w.stage === 0) return 'wrong';
  return s;
}

function counts() {
  const c = { new: 0, learning: 0, learned: 0 };
  for (const w of db.words) c[status(w)]++;
  return c;
}

function grade(w, ok) {
  const t = today();
  w.reviews++;
  w.lastSeen = t;
  w.updated = Date.now();
  if (!w.firstSeen) w.firstSeen = t;
  if (ok) {
    w.correct++;
    if (w.stage >= INTERVALS.length) { w.stage = LEARNED; w.due = null; }
    else { w.due = addDays(INTERVALS[w.stage]); w.stage++; }
  } else {
    w.wrong++;
    w.stage = 0;
    w.due = addDays(1);
  }
  const h = db.history[t] || (db.history[t] = { correct: 0, wrong: 0 });
  ok ? h.correct++ : h.wrong++;
  save();
}

function dueWords() {
  const t = today();
  return db.words
    .filter((w) => w.reviews > 0 && w.stage < LEARNED && w.due <= t)
    .sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage);
}

function newWords() {
  return db.words.filter((w) => w.reviews === 0).sort((a, b) => b.added - a.added); // newest first
}

function newLeftToday() {
  const t = today();
  const introduced = db.words.filter((w) => w.firstSeen === t).length;
  return Math.max(0, Math.min(db.settings.newPerDay - introduced, newWords().length));
}

function buildSet(ignoreNewLimit) {
  const size = db.settings.setSize;
  const picked = dueWords().slice(0, size);
  const freshCount = ignoreNewLimit ? size : newLeftToday();
  picked.push(...newWords().slice(0, Math.min(freshCount, size - picked.length)));
  return shuffle(picked.map((w) => w.id));
}

function dueOn(dateString) {
  return db.words.filter((w) => w.reviews > 0 && w.stage < LEARNED && w.due === dateString).length;
}

function streak() {
  let n = 0;
  const d = new Date();
  if (!db.history[dateStr(d)]) d.setDate(d.getDate() - 1);
  while (db.history[dateStr(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ---------- Answer checking ----------
function norm(s) {
  return String(s).toLowerCase().normalize('NFC')
    .replace(/ß/g, 'ss')
    .replace(/[.,!?;:"'«»„“”‚‘’()\[\]…]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Accepted spellings: alternatives split by ";", the part before a comma
// ("der Hund, die Hunde" → "der Hund"), and with/without parenthesised bits.
function candidates(de) {
  const out = new Set();
  for (const alt of de.split(';')) {
    for (const v of [alt, alt.split(',')[0]]) {
      out.add(norm(v));
      out.add(norm(v.replace(/\([^)]*\)/g, ' ')));
    }
  }
  out.delete('');
  return [...out];
}

function stripArticle(s) {
  const m = s.match(/^(der|die|das|den|dem|des) (.+)$/);
  return m ? m[2] : s;
}

function check(answers, de) {
  const cands = candidates(de);
  const given = answers.map(norm).filter(Boolean);
  for (const a of given) {
    if (cands.includes(a)) return { ok: true };
    // Expected has no article but one was said: still fine.
    if (cands.includes(stripArticle(a)) && cands.some((c) => c === stripArticle(c))) return { ok: true };
  }
  for (const a of given) {
    for (const c of cands) {
      if (stripArticle(c) !== c && stripArticle(a) === stripArticle(c)) return { ok: false, hint: 'Almost! Check the article' };
    }
  }
  return { ok: false };
}

// ---------- Dictionary check ----------
// Spelling and grammar come from LanguageTool, gender, plural and meanings from
// German Wiktionary. Both are free public APIs; when offline the check is skipped.
const LT_URL = 'https://api.languagetool.org/v2/check';
const WIKT_URL = 'https://de.wiktionary.org/w/api.php';
const ARTICLE_BY_GENUS = { m: 'der', f: 'die', n: 'das' };
const ARTICLE_RE = /^(der|die|das)\s+/i;

async function languageTool(text) {
  const res = await fetch(LT_URL, { method: 'POST', body: new URLSearchParams({ text, language: 'de-DE' }) });
  if (!res.ok) throw new Error(`LanguageTool ${res.status}`);
  const { matches } = await res.json();
  // Skip style hints and "capitalise the sentence start", which misfire on single words.
  return matches.filter((m) => m.rule.issueType === 'misspelling' || m.rule.category.id === 'GRAMMAR');
}

// Up to three corrected versions of `text` for one LanguageTool match. Word lists
// want the nominative, so den/dem/des variants are dropped, and a leading article
// is kept lowercase ("Das Kellner" → "der Kellner", not "Der Kellner").
function suggestionsFor(text, m) {
  return m.replacements
    .map((r) => r.value)
    .filter((v) => !/^(den|dem|des)\s/i.test(v))
    .slice(0, 3)
    .map((v) => (text.slice(0, m.offset) + v + text.slice(m.offset + m.length)).replace(/^(Der|Die|Das)\s/, (a) => a.toLowerCase()));
}

function germanSections(wikitext) {
  const parts = [];
  const re = /^==[^=\n]*\{\{Sprache\|Deutsch\}\}[^\n]*==\s*$/gm;
  let m;
  while ((m = re.exec(wikitext))) {
    const rest = wikitext.slice(m.index + m[0].length);
    const end = rest.search(/^==[^=]/m);
    parts.push(end === -1 ? rest : rest.slice(0, end));
  }
  return parts.join('\n');
}

function parseEntry(title, text) {
  const all = (re) => [...text.matchAll(re)].map((m) => m[1].trim());
  const clean = (s) => s.split('|').pop().replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/''+/g, '').trim();
  const pos = [...new Set(all(/\{\{Wortart\|([^|}]+)\|Deutsch\}\}/g))];
  return {
    title,
    pos,
    main: pos.filter((p) => !/Form|Komparativ|Superlativ|Partizip|Nachname|Vorname|Toponym/.test(p)),
    genders: [...new Set(all(/\|Genus(?: \d)?=([mfn])\b/g))],
    plural: all(/\|Nominativ Plural(?: \d)?=([^\n|}]*)/g).find((p) => p && !/^[—–-]$/.test(p)),
    base: [...new Set(all(/\{\{Grundformverweis[^|}]*\|([^}|]+)/g))],
    en: [...new Set(all(/\{\{Ü\|en\|([^}]+)\}\}/g).map(clean).filter(Boolean))],
  };
}

async function wiktionary(term) {
  const titles = [...new Set([term, term[0].toUpperCase() + term.slice(1), term[0].toLowerCase() + term.slice(1)])];
  const params = new URLSearchParams({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1', format: 'json', formatversion: '2', origin: '*', titles: titles.join('|') });
  const res = await fetch(`${WIKT_URL}?${params}`);
  if (!res.ok) throw new Error(`Wiktionary ${res.status}`);
  const data = await res.json();
  const entries = [];
  for (const p of data.query?.pages || []) {
    if (p.missing || !p.revisions) continue;
    const section = germanSections(p.revisions[0].slots.main.content);
    if (section) entries.push(parseEntry(p.title, section));
  }
  return entries;
}

function articlesFor(noun) {
  return noun.genders.length ? noun.genders.map((g) => ARTICLE_BY_GENUS[g]) : ['die'];
}

function translationMatches(en, translations) {
  const words = (s) => s.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z']+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'one', 'something', 'someone'].includes(w));
  const mine = new Set(words(en));
  return translations.some((t) => words(t).some((w) => mine.has(w)));
}

// Returns { ok, info, fixes: [{label, de?, en?}], notes: [string] }.
async function analyseWord(de, en) {
  de = de.trim();
  en = en.trim();
  const article = (de.match(ARTICLE_RE)?.[1] || '').toLowerCase();
  const term = de.replace(ARTICLE_RE, '').replace(/^\(?sich\)?\s+/i, '').split(/[;,]/)[0].trim();
  const single = term && !/\s/.test(term);
  const fixes = [], notes = [];
  const addFix = (f) => { if (!fixes.some((x) => x.de === f.de && x.en === f.en)) fixes.push(f); };

  const [ltRes, wiktRes] = await Promise.allSettled([languageTool(de), single ? wiktionary(term) : Promise.resolve([])]);
  if (ltRes.status === 'rejected' && wiktRes.status === 'rejected') throw new Error('no connection to the dictionaries');

  for (const m of ltRes.value || []) {
    const orig = de.slice(m.offset, m.offset + m.length);
    for (const fixed of suggestionsFor(de, m)) addFix({ label: `${orig} → ${fixed}`, de: fixed });
  }

  let entries = wiktRes.value || [];
  let viaFix = false;
  if (!entries.length && single && fixes.length) {
    // Misspelt: describe the most likely correction instead.
    const guess = fixes[0].de.replace(ARTICLE_RE, '').replace(/^\(?sich\)?\s+/i, '').trim();
    if (guess && !/\s/.test(guess)) {
      entries = await wiktionary(guess).catch(() => []);
      viaFix = entries.length > 0;
    }
  }

  const noun = entries.find((e) => e.main.includes('Substantiv'));
  const other = entries.find((e) => e.main.length && !e.main.includes('Substantiv'));
  // Without an article a capitalised list entry ("Geben", "Sauer") is usually a
  // verb or adjective, so prefer that reading and offer the noun as an alternative.
  const chosen = article ? noun : (other || noun);

  if (!viaFix && entries.length) {
    if (chosen && chosen === noun) {
      const arts = articlesFor(noun);
      const pluralOnly = article === 'die' && noun.plural === noun.title;
      if (!arts.includes(article) && !pluralOnly) {
        for (const a of arts) addFix({ label: article ? `Article: ${a} ${noun.title}` : `Add article: ${a} ${noun.title}`, de: `${a} ${noun.title}` });
      } else if (term !== noun.title) {
        addFix({ label: `Capitalise: ${article} ${noun.title}`, de: `${article} ${noun.title}` });
      }
    } else if (chosen) {
      if (term !== chosen.title) {
        addFix({ label: `Lowercase: ${chosen.title}`, de: de.replace(term, chosen.title) });
        if (noun) for (const a of articlesFor(noun)) addFix({ label: `Noun: ${a} ${noun.title}`, de: `${a} ${noun.title}` });
      }
    } else if (article && single) {
      notes.push(`Wiktionary has no noun “${term}”.`);
    }
    // Inflected forms ("verlässt", "stelle") point to their dictionary form.
    if (!article) {
      for (const e of entries) if (!e.main.length) for (const b of e.base.slice(0, 2)) addFix({ label: `Base form: ${b}`, de: b });
    }
  }

  let info = '';
  const shown = viaFix ? entries[0] : (chosen || entries[0]);
  if (shown) {
    const bits = [];
    if (shown.main.length) bits.push(shown.main.join(', '));
    if (shown.main.includes('Substantiv')) {
      bits.push(`${articlesFor(shown).join('/')} ${shown.title}${shown.plural && shown.plural !== shown.title ? `, pl. die ${shown.plural}` : ''}`);
    }
    if (shown.en.length) bits.push(shown.en.slice(0, 6).join(', '));
    if (bits.length) info = `${viaFix ? `Did you mean <b>${esc(shown.title)}</b>? ` : ''}${esc(bits.join(' · '))}`;
  }

  // Compare the translation against every reading, so "Sauer — angry" passes
  // via the adjective while "Reisig — huge" is flagged via the noun.
  const pool = viaFix ? [] : (article && noun ? [noun] : entries);
  const translations = [...new Set(pool.flatMap((e) => e.en))];
  if (translations.length) {
    if (!en) {
      for (const t of translations.slice(0, 3)) addFix({ label: `English: ${t}`, en: t });
    } else if (!translationMatches(en, translations)) {
      notes.push(`Wiktionary translates “${(chosen || entries[0]).title}” as: ${translations.slice(0, 6).join(', ')}. Check your translation “${en}”.`);
      for (const t of translations.slice(0, 2)) addFix({ label: `English: ${t}`, en: t });
    }
  }

  if (!entries.length && single && !fixes.length) {
    notes.push(`“${term}” isn’t in Wiktionary. Double-check the spelling.`);
  }

  return { ok: !fixes.some((f) => f.de) && !notes.length, info, fixes, notes };
}

function checkPanel(r) {
  if (!r) return '';
  if (r.loading) return '<div class="check muted small">Checking the dictionary…</div>';
  if (r.error) return `<div class="check muted small">Couldn’t check: ${esc(r.error)}</div>`;
  return `
    <div class="check ${r.ok ? 'good' : 'warn'}">
      ${r.ok ? '<div class="check-title">✓ Looks right</div>' : '<div class="check-title">Check this</div>'}
      ${r.info ? `<div class="check-info">${r.info}</div>` : ''}
      ${r.notes.map((n) => `<div class="check-note">${esc(n)}</div>`).join('')}
      ${r.fixes.length ? `<div class="check-fixes">${r.fixes.map((f, i) => `<button type="button" class="fix" data-fix="${i}">${esc(f.label)}</button>`).join('')}</div>` : ''}
    </div>`;
}

// Wires a check panel to a German/English input pair; returns run().
function attachChecker(box, deInput, enInput, onChange) {
  let result = null;
  const draw = () => { box.innerHTML = checkPanel(result); };
  const run = async () => {
    const de = deInput.value.trim(), en = enInput.value.trim();
    if (!de) return null;
    result = { loading: true }; draw();
    try { result = await analyseWord(de, en); }
    catch (e) { result = { error: e.message }; }
    result.key = `${de}|${en}`;
    draw();
    onChange?.();
    return result;
  };
  box.onclick = (e) => {
    const b = e.target.closest('[data-fix]');
    if (!b || !result?.fixes) return;
    const f = result.fixes[+b.dataset.fix];
    if (f.de) deInput.value = f.de;
    if (f.en) enInput.value = f.en;
    onChange?.();
    run();
  };
  return { run, get result() { return result; } };
}

// ---------- Navigation ----------
let current = 'home';

function go(name, arg) {
  stopListening();
  current = name;
  const inSession = name === 'session' || name === 'summary';
  nav.hidden = inSession;
  view.classList.toggle('session-mode', inSession);
  for (const b of nav.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.go === name || (name === 'edit' && b.dataset.go === 'words'));
  }
  const renderers = { home: renderHome, words: renderWords, add: renderAdd, settings: renderSettings, edit: renderEdit, session: renderCard, summary: renderSummary };
  renderers[name](arg);
  window.scrollTo(0, 0);
}

nav.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-go]');
  if (b) go(b.dataset.go);
});

// ---------- Home ----------
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone() { return navigator.standalone || matchMedia('(display-mode: standalone)').matches; }

function renderHome() {
  const c = counts();
  const total = db.words.length;
  const due = dueWords().length;
  const fresh = newLeftToday();
  const inSet = Math.min(db.settings.setSize, due + fresh);
  const pct = total ? Math.round((c.learned / total) * 100) : 0;
  const st = streak();
  const tomorrow = dueOn(addDays(1));

  const buckets = [
    { label: 'New', cls: '', n: c.new },
    { label: 'Mistakes', cls: 'wrong', n: db.words.filter((w) => w.reviews > 0 && w.stage === 0).length },
    ...INTERVALS.map((d, i) => ({ label: `${d} d`, cls: '', n: db.words.filter((w) => w.stage === i + 1).length })),
    { label: 'Learned', cls: 'learned', n: c.learned },
  ];
  const maxB = Math.max(1, ...buckets.map((b) => b.n));

  let todayBlock;
  if (!total) {
    todayBlock = `
      <h2>Nothing here yet</h2>
      <p class="muted">Add words one by one or import your list.</p>
      <button class="btn primary block big" data-act="add">Add words</button>`;
  } else if (inSet) {
    todayBlock = `
      <h2>Today</h2>
      <div class="kv"><span>To review</span><b>${due}</b></div>
      <div class="kv"><span>New words</span><b>${fresh}</b></div>
      <button class="btn primary block big" data-act="start">Start · ${plural(inSet, 'card')}</button>`;
  } else {
    const more = newWords().length;
    todayBlock = `
      <div class="done-badge">${ICONS.check}<span>All done for today!</span></div>
      <p class="muted small" style="margin-top:6px">Due tomorrow: ${wordsN(tomorrow)}.</p>
      ${more ? `<button class="btn block" data-act="extra">Learn more new words (${more} left)</button>` : ''}`;
  }

  const installHint = isIOS() && !isStandalone() ? `
    <div class="card soft small">
      <b>Install it:</b> tap Share → “Add to Home Screen”.
      Safari and the installed app keep separate data, so import your words inside the installed app.
    </div>` : '';

  view.innerHTML = `
    <header class="top">
      <h1>Wortkarten</h1>
      <p class="muted">${st ? `🔥 ${days(st)} in a row` : 'German vocabulary with spaced repetition'}</p>
    </header>
    ${installHint}
    <div class="card">
      <div class="hero-num">${c.learned}<span> / ${total}</span></div>
      <div class="muted" style="margin-top:6px">words learned · ${pct}%</div>
      <div class="bar"><span style="width:${pct}%"></span></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${c.new}</b><span>new</span></div>
      <div class="stat"><b>${c.learning}</b><span>learning</span></div>
      <div class="stat"><b>${c.learned}</b><span>learned</span></div>
    </div>
    <div class="card today">${todayBlock}</div>
    ${total ? `
    <div class="card">
      <h2>By stage</h2>
      <div class="buckets">
        ${buckets.map((b) => `
          <div class="bucket ${b.cls}">
            <span class="muted">${b.label}</span>
            <div class="track"><span style="width:${(b.n / maxB) * 100}%"></span></div>
            <b>${b.n}</b>
          </div>`).join('')}
      </div>
    </div>` : ''}`;

  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'start') startSession(false);
    if (act === 'extra') startSession(true);
    if (act === 'add') go('add');
  };
}

// ---------- Session ----------
let session = null;
let recog = null;

function startSession(ignoreNewLimit) {
  const ids = buildSet(ignoreNewLimit);
  if (!ids.length) { toast('Nothing to review right now'); return; }
  session = { ids, i: 0, results: [] };
  resetCard();
  go('session');
}

function resetCard() {
  Object.assign(session, { attempts: 0, pending: null, feedback: '', tries: [], shake: false });
}

function currentWord() {
  return db.words.find((w) => w.id === session.ids[session.i]);
}

function renderCard() {
  const w = currentWord();
  if (!w) { nextCard(); return; }
  const n = session.ids.length;
  const p = session.pending;
  const state = p ? (p.ok ? 'ok' : 'bad') : '';
  const left = MAX_ATTEMPTS - session.attempts;
  const dots = Array.from({ length: LEARNED }, (_, i) => `<i class="${i < w.stage ? 'on' : ''}"></i>`).join('');
  const wrongTries = session.tries.filter(Boolean);

  view.innerHTML = `
    <div class="session">
      <div class="session-top">
        <button class="icon-btn" data-act="quit" aria-label="End session">${ICONS.close}</button>
        <div class="progress"><span style="width:${(session.i / n) * 100}%"></span></div>
        <span class="count">${session.i + 1}/${n}</span>
      </div>

      <div class="flash ${state} ${session.shake ? 'shake' : ''}">
        <div class="lang">English${status(w) === 'new' ? ' · new word' : ''}</div>
        <div class="prompt">${esc(w.en)}</div>
        <div class="dots" title="Word progress">${dots}</div>
        ${p ? `
          <div class="answer">
            <div class="de">${esc(w.de)}
              <button class="icon-btn" data-act="speak" aria-label="Pronounce">${ICONS.speaker}</button>
            </div>
            ${!p.ok && wrongTries.length ? `<div class="you">You said: ${wrongTries.map((t) => `<s>${esc(t)}</s>`).join(', ')}</div>` : ''}
            <div class="verdict">${p.ok ? (p.overridden ? 'Counted as correct ✓' : 'Correct!') : 'Missed — back tomorrow'}</div>
          </div>` : ''}
        ${!p && session.feedback ? `<div class="feedback">${esc(session.feedback)}</div>` : ''}
      </div>

      ${p ? `
        <button class="btn primary block big" data-act="next" id="next">${session.i + 1 < n ? 'Next' : 'See results'}</button>
        ${!p.ok ? '<button class="btn ghost block" data-act="override">I was right</button>' : ''}
      ` : `
        <form class="answer-row" id="answer-form" autocomplete="off">
          <input id="answer" type="text" lang="de" placeholder="In German…" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="done">
        </form>
        <div class="btn-row">
          <button class="btn" data-act="dontknow">Don’t know</button>
          <button class="btn primary" data-act="check">Check</button>
        </div>
        <p class="muted small" style="text-align:center;margin-top:12px">${left === 1 && session.attempts ? 'Last try' : plural(left, 'try', 'tries')}</p>
      `}
      <div class="spacer"></div>
    </div>`;

  session.shake = false;
  const input = $('#answer');
  if (input) {
    input.focus({ preventScroll: true });
    $('#answer-form').onsubmit = (e) => { e.preventDefault(); submitTyped(); };
  } else {
    $('#next')?.focus({ preventScroll: true });
  }

  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'quit') quitSession();
    if (act === 'check') submitTyped();
    if (act === 'dontknow') reveal(false);
    if (act === 'speak') speak(w.de);
    if (act === 'next') nextCard();
    if (act === 'override') { session.pending = { ok: true, overridden: true }; renderCard(); }
  };
}

function submitTyped() {
  const v = $('#answer')?.value.trim();
  if (!v) { toast('Type or say the word'); return; }
  submitAnswer([v]);
}

function submitAnswer(answers) {
  if (!session || session.pending) return;
  const w = currentWord();
  const res = check(answers, w.de);
  if (res.ok) { reveal(true); return; }
  session.tries.push(answers[0]);
  session.attempts++;
  if (session.attempts >= MAX_ATTEMPTS) { reveal(false); return; }
  session.feedback = res.hint || `“${answers[0]}” is wrong. Try again`;
  session.shake = true;
  renderCard();
}

function reveal(ok) {
  stopListening();
  session.pending = { ok };
  if (db.settings.autoSpeak) speak(currentWord().de);
  renderCard();
}

function nextCard() {
  const w = currentWord();
  if (w && session.pending) {
    grade(w, session.pending.ok);
    session.results.push({ id: w.id, ok: session.pending.ok });
  }
  session.i++;
  resetCard();
  if (session.i >= session.ids.length) go('summary');
  else renderCard();
}

function quitSession() {
  if (session.results.length) go('summary');
  else { session = null; go('home'); }
}

document.addEventListener('keydown', (e) => {
  if (current === 'session' && session?.pending && e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    nextCard();
  }
});

// ---------- Voice input ----------
function toggleMic() {
  if (recog) { recog.stop(); return; }
  const input = $('#answer');
  const btn = view.querySelector('.mic');
  let alts = [];
  try { recog = new SR(); } catch (e) { toast('Voice input unavailable — use the keyboard mic'); return; }
  const r = recog;
  r.lang = 'de-DE';
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 5;
  r.onresult = (e) => {
    const results = Array.from(e.results);
    const last = results[results.length - 1];
    const prefix = results.slice(0, -1).map((x) => x[0].transcript).join(' ');
    alts = Array.from(last, (a) => `${prefix} ${a.transcript}`.trim());
    if (input) input.value = alts[0] || '';
    if (last.isFinal) r.stop();
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Speech recognition not allowed — use the keyboard mic');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Recognition error: ' + e.error);
  };
  r.onend = () => {
    if (recog === r) recog = null;
    btn?.classList.remove('listening');
    if (alts.length && current === 'session' && session && !session.pending) submitAnswer(alts);
  };
  btn?.classList.add('listening');
  try { r.start(); } catch (e) { recog = null; btn?.classList.remove('listening'); toast('Could not start the microphone'); }
}

function stopListening() {
  if (recog) { const r = recog; recog = null; r.onend = null; try { r.abort(); } catch (e) { /* already stopped */ } }
}

// ---------- Summary ----------
function renderSummary() {
  const res = session.results;
  const good = res.filter((r) => r.ok).length;
  const bad = res.length - good;
  const more = buildSet(false).length;
  const row = (r) => {
    const w = db.words.find((x) => x.id === r.id);
    if (!w) return '';
    return `<div class="word" style="cursor:default"><div class="w-main"><b>${esc(w.de)}</b><span class="w-en">${esc(w.en)}</span></div><span class="badge ${badgeClass(w)}">${stageLabel(w)}</span></div>`;
  };

  view.innerHTML = `
    <header class="top"><h1>Set complete</h1></header>
    <div class="summary-score">
      <div class="good"><b>${good}</b>knew</div>
      <div class="poor"><b>${bad}</b>missed</div>
    </div>
    ${bad ? `<h2>Back tomorrow</h2><div class="list" style="margin-bottom:18px">${res.filter((r) => !r.ok).map(row).join('')}</div>` : ''}
    ${good ? `<h2>Correct</h2><div class="list" style="margin-bottom:18px">${res.filter((r) => r.ok).map(row).join('')}</div>` : ''}
    ${more ? `<button class="btn primary block big" data-act="again">Another set</button>` : ''}
    <button class="btn block big" data-act="home" style="margin-top:10px">Home</button>`;

  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'again') startSession(false);
    if (act === 'home') { session = null; go('home'); }
  };
}

// ---------- Word list ----------
let wordsQuery = '';
let wordsFilter = 'all';

function renderWords() {
  const c = counts();
  const filters = [
    ['all', `All ${db.words.length}`],
    ['new', `New ${c.new}`],
    ['learning', `Learning ${c.learning}`],
    ['learned', `Learned ${c.learned}`],
  ];
  view.innerHTML = `
    <header class="top"><h1>Words</h1></header>
    <input type="search" id="q" placeholder="Search German or English" value="${esc(wordsQuery)}" autocapitalize="none" autocorrect="off">
    <div class="chips">${filters.map(([k, l]) => `<button class="chip ${wordsFilter === k ? 'active' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
    <div id="word-list"></div>`;

  $('#q').oninput = (e) => { wordsQuery = e.target.value; renderWordList(); };
  view.onclick = (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) { wordsFilter = f.dataset.filter; renderWords(); return; }
    const item = e.target.closest('[data-id]');
    if (item) go('edit', item.dataset.id);
  };
  renderWordList();
}

function renderWordList() {
  const q = norm(wordsQuery);
  const list = db.words
    .filter((w) => wordsFilter === 'all' || status(w) === wordsFilter)
    .filter((w) => !q || norm(w.de).includes(q) || norm(w.en).includes(q))
    .sort((a, b) => b.added - a.added);
  const shown = list.slice(0, 400);
  $('#word-list').innerHTML = list.length ? `
    <div class="list">${shown.map((w) => `
      <button class="word" data-id="${w.id}">
        <div class="w-main"><b>${esc(w.de)}</b><span class="w-en">${esc(w.en)}</span></div>
        <span class="badge ${badgeClass(w)}">${stageLabel(w)}</span>
      </button>`).join('')}
    </div>
    ${list.length > shown.length ? `<p class="muted small" style="margin-top:10px">Showing ${shown.length} of ${list.length}. Narrow the search.</p>` : ''}`
    : `<p class="muted">${db.words.length ? 'Nothing found' : 'No words yet'}</p>`;
}

// ---------- Edit ----------
function renderEdit(id) {
  const w = db.words.find((x) => x.id === id);
  if (!w) { go('words'); return; }
  view.innerHTML = `
    <header class="top top-row">
      <button class="icon-btn" data-act="back" aria-label="Back">${ICONS.back}</button>
      <h1 style="flex:1;margin:0">Word</h1>
      <button class="icon-btn" data-act="speak" aria-label="Pronounce">${ICONS.speaker}</button>
    </header>
    <div class="card">
      <label class="field"><span>German</span><input type="text" id="e-de" value="${esc(w.de)}" lang="de" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>English</span><input type="text" id="e-en" value="${esc(w.en)}" autocapitalize="none"></label>
      <div id="e-check"></div>
      <div class="btn-row">
        <button class="btn" data-act="check">Check</button>
        <button class="btn primary" data-act="save">Save</button>
      </div>
    </div>
    <div class="card">
      <div class="kv"><span class="muted">Status</span><b>${stageLabel(w)}</b></div>
      <div class="kv"><span class="muted">Correct / wrong</span><b>${w.correct} / ${w.wrong}</b></div>
      <div class="kv"><span class="muted">Added</span><b>${dateStr(new Date(w.added))}</b></div>
    </div>
    <div class="btn-row">
      <button class="btn" data-act="reset">Reset progress</button>
      <button class="btn danger" data-act="delete">Delete</button>
    </div>`;

  const checker = attachChecker($('#e-check'), $('#e-de'), $('#e-en'));

  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'check') checker.run();
    if (act === 'back') go('words');
    if (act === 'speak') speak($('#e-de').value);
    if (act === 'save') {
      const de = $('#e-de').value.trim(), en = $('#e-en').value.trim();
      if (!de || !en) { toast('Both fields are required'); return; }
      Object.assign(w, { de, en, updated: Date.now() });
      save(); toast('Saved'); go('words');
    }
    if (act === 'reset' && confirm('Start learning this word from scratch?')) {
      Object.assign(w, { stage: 0, due: today(), reviews: 0, correct: 0, wrong: 0, firstSeen: null, lastSeen: null, updated: Date.now() });
      save(); renderEdit(id);
    }
    if (act === 'delete' && confirm(`Delete “${w.de}”?`)) {
      removeWords([id]);
      save(); toast('Deleted'); go('words');
    }
  };
}

// ---------- Add & import ----------
let importOrder = 'de-en';
let importText = '';
let importFixes = new Map(); // original German → corrected German
let importCheck = null; // { key, items: [{ de, options }] } | { loading } | { error }

function existingKeys() { return new Set(db.words.map((w) => norm(w.de))); }

function stripQuotes(s) { return s.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"').trim(); }

const SEPARATORS = [/\s+[—–]\s+/, /\s+-\s+/, /\s*=\s*/, /\s*;\s*/, /\s*[—–]\s*/, /\s*\|\s*/, /\s+->\s+|\s+→\s+/];
const HEADER = /^(german|deutsch|de|word|wort|english|en)$/i;

function splitLine(line) {
  if (line.includes('\t')) {
    const parts = line.split('\t').map(stripQuotes).filter(Boolean);
    return parts.length >= 2 ? [parts[0], parts[1]] : null;
  }
  for (const re of SEPARATORS) {
    const m = line.match(re);
    if (m) {
      const a = stripQuotes(line.slice(0, m.index)), b = stripQuotes(line.slice(m.index + m[0].length));
      if (a && b) return [a, b];
    }
  }
  const commas = line.match(/^("[^"]*"|[^,]*),(.*)$/);
  if (commas && line.split(',').length === 2) {
    const a = stripQuotes(commas[1]), b = stripQuotes(commas[2]);
    if (a && b) return [a, b];
  }
  return null;
}

function parseImport(text, order) {
  const t = text.trim();
  if (/^[\[{]/.test(t)) {
    try {
      const data = JSON.parse(t);
      const arr = Array.isArray(data) ? data : data.words;
      if (Array.isArray(arr)) {
        return { pairs: arr.filter((x) => x && x.de && x.en).map((x) => ({ de: String(x.de).trim(), en: String(x.en).trim(), saved: x })), bad: [] };
      }
    } catch (e) { /* not JSON, parse as text */ }
  }
  const pairs = [], bad = [];
  for (let line of t.split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[-*•–]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const p = splitLine(line);
    if (!p) { bad.push(line); continue; }
    const [de, en] = order === 'de-en' ? p : [p[1], p[0]];
    if (HEADER.test(de) && HEADER.test(en)) continue;
    pairs.push({ de, en });
  }
  return { pairs, bad };
}

function renderAdd() {
  view.innerHTML = `
    <header class="top"><h1>Add words</h1></header>
    <form class="card" id="add-form" autocomplete="off">
      <h2>One word</h2>
      <label class="field"><span>German</span><input type="text" id="a-de" lang="de" placeholder="der Hund" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
      <label class="field"><span>English</span><input type="text" id="a-en" placeholder="dog" autocapitalize="none"></label>
      <div id="a-check"></div>
      <button class="btn primary block" type="submit" id="a-submit">Check &amp; add</button>
    </form>

    <div class="card">
      <h2>Import a list</h2>
      <p class="muted small">Paste words from your notes, one pair per line, e.g. <b>der Hund — dog</b>. Separators: dash, tab, “=”, “;” or comma (CSV). You can also pick a .txt, .csv or .json file.</p>
      <div class="seg" role="group" aria-label="Column order">
        <button data-order="de-en" class="${importOrder === 'de-en' ? 'active' : ''}">German — English</button>
        <button data-order="en-de" class="${importOrder === 'en-de' ? 'active' : ''}">English — German</button>
      </div>
      <textarea id="imp" placeholder="der Hund — dog&#10;die Katze — cat&#10;sich erinnern — to remember">${esc(importText)}</textarea>
      <div class="btn-row" style="margin-top:10px">
        <label class="btn file-btn">Choose file<input type="file" id="imp-file" accept=".txt,.csv,.tsv,.json,.md,text/plain,text/csv,application/json"></label>
      </div>
      <div class="preview" id="imp-preview"></div>
    </div>`;

  const deIn = $('#a-de'), enIn = $('#a-en'), submit = $('#a-submit'), checkBox = $('#a-check');
  const key = () => `${deIn.value.trim()}|${enIn.value.trim()}`;
  // The first press checks; if the dictionary objects, a second press adds anyway.
  const syncLabel = () => {
    const r = checker.result;
    const fresh = r && r.key === key() && !r.loading;
    submit.textContent = !fresh ? 'Check & add' : r.ok || r.error ? 'Add' : 'Add anyway';
  };
  const checker = attachChecker(checkBox, deIn, enIn, syncLabel);
  deIn.oninput = enIn.oninput = syncLabel;

  const add = (de, en, unchecked) => {
    db.words.push(newWord(de, en));
    save();
    toast(unchecked ? `Added: ${de} (not checked, offline)` : `Added: ${de}`);
    deIn.value = ''; enIn.value = '';
    checkBox.innerHTML = '';
    syncLabel();
    deIn.focus();
  };

  $('#add-form').onsubmit = async (e) => {
    e.preventDefault();
    const de = deIn.value.trim(), en = enIn.value.trim();
    if (!de || !en) { toast('Fill in both fields'); return; }
    if (existingKeys().has(norm(de))) { toast(`“${de}” is already in your list`); return; }
    const prev = checker.result;
    if (prev && prev.key === key() && !prev.loading) { add(de, en); return; }
    submit.disabled = true;
    const r = await checker.run();
    submit.disabled = false;
    if (r && r.key === key() && (r.ok || r.error)) add(de, en, !!r.error);
    else syncLabel();
  };

  $('#imp').oninput = (e) => { importText = e.target.value; renderPreview(); };
  $('#imp-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    importText = await file.text();
    $('#imp').value = importText;
    renderPreview();
  };
  view.onclick = (e) => {
    const o = e.target.closest('[data-order]');
    if (o) { importOrder = o.dataset.order; renderAdd(); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'import') doImport();
    if (act === 'spell') runSpelling();
    const pick = e.target.closest('[data-spell]');
    if (pick) {
      const [i, j] = pick.dataset.spell.split(':').map(Number);
      const it = importCheck.items[i];
      importFixes.set(it.de, it.options[j]);
      renderPreview();
    }
    const undo = e.target.closest('[data-undo]');
    if (undo) { importFixes.delete(importCheck.items[+undo.dataset.undo].de); renderPreview(); }
  };
  renderPreview();
}

function analyseImport() {
  const { pairs, bad } = parseImport(importText, importOrder);
  const keys = existingKeys();
  const fresh = [], dupes = [];
  for (const p of pairs) {
    if (importFixes.has(p.de)) p.de = importFixes.get(p.de);
    const k = norm(p.de);
    if (keys.has(k)) dupes.push(p); else { keys.add(k); fresh.push(p); }
  }
  return { fresh, dupes, bad };
}

function renderPreview() {
  const box = $('#imp-preview');
  if (!importText.trim()) { box.innerHTML = ''; return; }
  const { fresh, dupes, bad } = analyseImport();
  box.innerHTML = `
    <p><b>New: ${fresh.length}</b>${dupes.length ? ` · already in list: ${dupes.length}` : ''}${bad.length ? ` · <span class="warn">couldn’t read: ${bad.length}</span>` : ''}</p>
    ${fresh.length ? `<table>${fresh.slice(0, 6).map((p) => `<tr><td>${esc(p.de)}</td><td>${esc(p.en)}</td></tr>`).join('')}</table>
      ${fresh.length > 6 ? `<p class="muted">…and ${fresh.length - 6} more</p>` : ''}` : ''}
    ${bad.length ? `<details><summary>Lines that couldn’t be read</summary><p class="muted">${bad.slice(0, 50).map(esc).join('<br>')}</p></details>` : ''}
    <p class="muted">Check that German is on the left and English on the right. If not, switch the order above.</p>
    ${fresh.length ? spellingBlock() : ''}
    <button class="btn primary block" data-act="import" ${fresh.length ? '' : 'disabled'}>Import ${wordsN(fresh.length)}</button>`;
}

function importKey() { return `${importOrder}\n${importText}`; }

function spellingBlock() {
  const c = importCheck && (importCheck.loading || importCheck.error || importCheck.key === importKey()) ? importCheck : null;
  if (!c) return '<button class="btn block" data-act="spell" style="margin-bottom:10px">Check spelling</button>';
  if (c.loading) return '<div class="check muted small">Checking spelling…</div>';
  if (c.error) return `<div class="check muted small">Couldn’t check: ${esc(c.error)} <button class="fix" data-act="spell">Try again</button></div>`;
  const open = c.items.filter((it) => !importFixes.has(it.de));
  if (!c.items.length) return '<div class="check good"><div class="check-title">✓ No spelling mistakes found</div></div>';
  return `
    <div class="check warn">
      <div class="check-title">${open.length ? `Possible mistakes: ${open.length}` : '✓ All fixes applied'}</div>
      ${c.items.map((it, i) => `
        <div class="spell-row">
          ${importFixes.has(it.de)
            ? `<span><s>${esc(it.de)}</s> → <b>${esc(importFixes.get(it.de))}</b></span><button class="fix" data-undo="${i}">Undo</button>`
            : `<span>${esc(it.de)}</span>${it.options.map((o, j) => `<button class="fix" data-spell="${i}:${j}">${esc(o)}</button>`).join('')}`}
        </div>`).join('')}
      <p class="muted small" style="margin-top:8px">Tap the right spelling. Words you leave alone are imported as written.</p>
    </div>`;
}

async function runSpelling() {
  const { fresh } = analyseImport();
  const lines = fresh.map((p) => p.de);
  const key = importKey();
  importCheck = { loading: true };
  renderPreview();
  try {
    const text = lines.join('\n\n');
    const starts = [];
    lines.reduce((pos, l) => { starts.push(pos); return pos + l.length + 2; }, 0);
    const byLine = new Map();
    for (const m of await languageTool(text)) {
      const i = starts.findLastIndex((s) => s <= m.offset);
      const de = lines[i];
      const options = suggestionsFor(de, { ...m, offset: m.offset - starts[i] });
      if (options.length && !byLine.has(de)) byLine.set(de, { de, options });
    }
    importCheck = { key, items: [...byLine.values()] };
  } catch (e) {
    importCheck = { error: e.message };
  }
  if (current === 'add') renderPreview();
}

function doImport() {
  const { fresh } = analyseImport();
  const base = Date.now();
  fresh.forEach((p, i) => {
    const w = newWord(p.de, p.en);
    w.added = base - i; // newest-first queue: words added later come first, the list keeps its order
    const s = p.saved;
    if (s && typeof s.stage === 'number') {
      for (const k of ['stage', 'due', 'reviews', 'correct', 'wrong', 'firstSeen', 'lastSeen']) if (k in s) w[k] = s[k];
    }
    db.words.push(w);
  });
  save();
  importText = '';
  importFixes = new Map();
  importCheck = null;
  toast(`Imported ${wordsN(fresh.length)}`);
  go('home');
}

// ---------- Settings & backup ----------
function renderSettings() {
  const s = db.settings;
  view.innerHTML = `
    <header class="top"><h1>Settings</h1></header>
    <div class="card">
      <div class="switch-row"><span>Cards per set</span><input type="number" id="s-set" min="5" max="50" value="${s.setSize}" inputmode="numeric"></div>
      <div class="switch-row"><span>New words per day</span><input type="number" id="s-new" min="0" max="200" value="${s.newPerDay}" inputmode="numeric"></div>
      <label class="switch-row"><span>Read the answer aloud</span><input type="checkbox" id="s-speak" ${s.autoSpeak ? 'checked' : ''}></label>
    </div>

    <div class="card">
      <h2>How reviews work</h2>
      <p class="muted small">New word → correct → again in 1 day → 3 → 7 → 14 → 30 days. After 6 correct answers in a row the word is learned and won’t be shown again. A mistake sends it back to tomorrow and it starts over. You get ${MAX_ATTEMPTS} tries per card.</p>
    </div>

    <div class="card" id="sync-card">${syncCardHtml()}</div>

    <div class="card">
      <h2>Backup</h2>
      <p class="muted small">Your words live only on this device. Save a copy to Files now and then.</p>
      <div class="btn-row">
        <button class="btn" data-act="export">Export</button>
        <label class="btn file-btn">Restore<input type="file" id="restore" accept=".json,application/json"></label>
      </div>
    </div>

    <button class="btn danger block" data-act="wipe">Delete all words</button>
    <p class="muted small" style="text-align:center;margin-top:16px">${voiceNote()}</p>`;

  const num = (el, min, max, key) => {
    el.onchange = () => {
      const v = Math.max(min, Math.min(max, parseInt(el.value, 10) || DEFAULT_SETTINGS[key]));
      el.value = v; s[key] = v; db.settingsUpdated = Date.now(); save();
    };
  };
  num($('#s-set'), 5, 50, 'setSize');
  num($('#s-new'), 0, 200, 'newPerDay');
  $('#s-speak').onchange = (e) => { s.autoSpeak = e.target.checked; db.settingsUpdated = Date.now(); save(); };

  $('#restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.words)) throw new Error('no word list');
      if (!confirm(`Replace your current words (${db.words.length}) with the backup (${data.words.length})?`)) return;
      // Restored words count as the newest edits, so sync keeps them over older copies.
      const now = Date.now();
      removeWords(db.words.map((w) => w.id));
      const restored = fromData(data);
      for (const w of restored.words) { w.updated = now; delete db.tombstones[w.id]; }
      db = { ...restored, tombstones: { ...db.tombstones, ...restored.tombstones }, settingsUpdated: now };
      save(); toast('Backup restored'); go('home');
    } catch (err) { toast('Not a Wortkarten backup: ' + err.message); }
  };

  view.onclick = (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'export') exportBackup();
    if (act === 'connect') {
      const token = $('#s-token').value.trim();
      if (!token) { toast('Paste the token first'); return; }
      e.target.disabled = true;
      e.target.textContent = 'Connecting…';
      connectSync(token);
    }
    if (act === 'sync') { syncNow(); renderSyncCard(); }
    if (act === 'disconnect' && confirm('Stop syncing on this device? Your words stay here and in the gist.')) {
      sync = {}; saveSync(); renderSyncCard();
    }
    if (act === 'wipe' && db.words.length && confirm(`Permanently delete all ${wordsN(db.words.length)}?`)) {
      removeWords(db.words.map((w) => w.id)); db.history = {}; save(); toast('All words deleted'); go('home');
    }
  };
}

function voiceNote() {
  return 'Voice input: use the mic on the iPhone keyboard.';
}

async function exportBackup() {
  const data = JSON.stringify({ app: 'wortkarten', version: 1, exported: new Date().toISOString(), ...db }, null, 1);
  const name = `wortkarten-${today()}.json`;
  const file = new File([data], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- Sync (GitHub Gist) ----------
// Optional. All data lives in one file in a secret gist on the user's GitHub
// account; each device pulls it, merges, and pushes the result back. Per word the
// newest `updated` wins, deletions are kept as tombstones, and the same German word
// added on two devices collapses into the copy with more progress.
const SYNC_KEY = 'wortkarten.sync'; // kept apart from the word data so Export never contains the token
const GIST_FILE = 'wortkarten-sync.json';
let sync = loadSync(); // { token, login, gistId, lastSync, error }
let syncTimer = null;
let syncing = null;

function loadSync() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; }
}
function saveSync() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* not critical */ }
}

function scheduleSync() {
  if (!sync.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({ quiet: true }), 4000);
}

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${sync.token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com${path}`, { ...opts, headers, cache: 'no-store' });
  if (res.status === 401) throw new Error('GitHub rejected the token');
  if (res.status === 404) { const e = new Error('not found on GitHub (does the token have the “gist” scope?)'); e.notFound = true; throw e; }
  if (!res.ok) throw new Error(`GitHub error ${res.status}`);
  return res.json();
}

function snapshot() {
  return { app: 'wortkarten', version: 1, words: db.words, tombstones: db.tombstones, settings: db.settings, settingsUpdated: db.settingsUpdated, history: db.history };
}

async function findOrCreateGist() {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files && g.files[GIST_FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  const created = await gh('/gists', {
    method: 'POST',
    body: JSON.stringify({ description: 'Wortkarten sync', public: false, files: { [GIST_FILE]: { content: JSON.stringify(snapshot()) } } }),
  });
  return created.id;
}

async function readGist() {
  const g = await gh(`/gists/${sync.gistId}`);
  const f = g.files[GIST_FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
  return JSON.parse(text);
}

function mergeData(local, remote) {
  const tomb = { ...local.tombstones };
  for (const [id, t] of Object.entries(remote.tombstones || {})) tomb[id] = Math.max(tomb[id] || 0, t);

  const byId = new Map();
  for (const w of [...local.words, ...(remote.words || [])]) {
    const cur = byId.get(w.id);
    if (!cur || (w.updated || 0) > (cur.updated || 0)) byId.set(w.id, w);
  }

  const more = (a, b) => (a.reviews - b.reviews) || ((a.updated || 0) - (b.updated || 0));
  const byKey = new Map();
  for (const w of byId.values()) {
    if (tomb[w.id] >= (w.updated || 0)) continue;
    const k = norm(w.de);
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, w); continue; }
    const [keep, drop] = more(w, cur) > 0 ? [w, cur] : [cur, w];
    byKey.set(k, keep);
    tomb[drop.id] = Math.max(tomb[drop.id] || 0, drop.updated || 0);
  }

  const history = { ...local.history };
  for (const [d, h] of Object.entries(remote.history || {})) {
    const mine = history[d] || { correct: 0, wrong: 0 };
    history[d] = { correct: Math.max(mine.correct, h.correct), wrong: Math.max(mine.wrong, h.wrong) };
  }

  const remoteSettingsNewer = (remote.settingsUpdated || 0) > (local.settingsUpdated || 0);
  return {
    words: [...byKey.values()].sort((a, b) => a.added - b.added),
    tombstones: tomb,
    settings: remoteSettingsNewer ? { ...DEFAULT_SETTINGS, ...remote.settings } : local.settings,
    settingsUpdated: Math.max(local.settingsUpdated || 0, remote.settingsUpdated || 0),
    history,
  };
}

function syncNow({ quiet } = {}) {
  if (!sync.token) return Promise.resolve();
  if (syncing) return syncing;
  clearTimeout(syncTimer);
  syncing = (async () => {
    try {
      if (!sync.gistId) sync.gistId = await findOrCreateGist();
      let remote;
      try { remote = await readGist(); }
      catch (e) {
        if (!e.notFound) throw e;
        sync.gistId = await findOrCreateGist(); // gist was deleted: start a new one
        remote = await readGist();
      }
      if (remote) db = mergeData(db, remote);
      writeLocal();
      const merged = JSON.stringify(snapshot());
      if (!remote || merged !== JSON.stringify(remote)) {
        await gh(`/gists/${sync.gistId}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: merged } } }) });
      }
      Object.assign(sync, { lastSync: Date.now(), error: null });
      if (!quiet) toast(`Synced · ${wordsN(db.words.length)}`);
    } catch (e) {
      sync.error = e.message;
      if (!quiet) toast('Sync failed: ' + e.message);
    } finally {
      saveSync();
      syncing = null;
      if (current === 'home') renderHome();
      if (current === 'settings') renderSyncCard();
    }
  })();
  return syncing;
}

async function connectSync(token) {
  sync = { token };
  try {
    const user = await gh('/user');
    sync.login = user.login;
    saveSync();
    await syncNow();
  } catch (e) {
    sync = {};
    saveSync();
    toast('Could not connect: ' + e.message);
  }
  renderSyncCard();
}

function syncCardHtml() {
  if (!sync.token) {
    return `
      <h2>Sync between devices</h2>
      <p class="muted small">Keep words and progress the same on your iPhone and Mac. They are stored in a secret gist on your GitHub account. Create a token with only the <b>gist</b> permission and paste it here on each device.</p>
      <a class="btn block" href="https://github.com/settings/tokens/new?scopes=gist&description=Wortkarten%20sync" target="_blank" rel="noopener" style="margin-bottom:10px">Create a token on GitHub</a>
      <input type="password" id="s-token" placeholder="Paste token (ghp_…)" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" style="margin-bottom:10px">
      <button class="btn primary block" data-act="connect">Connect</button>`;
  }
  const when = sync.lastSync ? new Date(sync.lastSync).toLocaleString() : 'not yet';
  return `
    <h2>Sync between devices</h2>
    <div class="kv"><span class="muted">GitHub account</span><b>${esc(sync.login || '—')}</b></div>
    <div class="kv"><span class="muted">Last sync</span><b>${esc(syncing ? 'syncing…' : when)}</b></div>
    ${sync.error ? `<p class="small warn" style="color:var(--bad)">${esc(sync.error)}</p>` : ''}
    <div class="btn-row" style="margin-top:10px">
      <button class="btn" data-act="disconnect">Disconnect</button>
      <button class="btn primary" data-act="sync">Sync now</button>
    </div>`;
}

function renderSyncCard() {
  const el = $('#sync-card');
  if (el) el.innerHTML = syncCardHtml();
}

// ---------- Boot ----------
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (current === 'home') renderHome();
  syncNow({ quiet: true });
});
window.addEventListener('online', () => syncNow({ quiet: true }));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

go('home');
syncNow({ quiet: true });
