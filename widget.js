// Wortkarten widget for the Scriptable app (iOS). The app's Settings → Sync → "Copy widget code"
// copies this file with WIDGET_DATA_URL filled in; paste it into a new Scriptable script.
// Shows 3 hard words (ones you didn't know or missed). The set changes every 3 hours
// at 8:00, 11:00, 14:00, 17:00 and 20:00; the 20:00 set stays overnight until 8:00.

const DATA_URL = 'WIDGET_DATA_URL';
const PER_SLOT = 3;
const FIRST_HOUR = 8;
const STEP = 3;
const SLOTS_PER_DAY = 5; // 8, 11, 14, 17, 20

function slotStart(d) {
  const s = new Date(d);
  s.setMinutes(0, 0, 0);
  const h = d.getHours();
  if (h < FIRST_HOUR) { s.setDate(s.getDate() - 1); s.setHours(FIRST_HOUR + STEP * (SLOTS_PER_DAY - 1)); }
  else s.setHours(Math.min(FIRST_HOUR + STEP * Math.floor((h - FIRST_HOUR) / STEP), FIRST_HOUR + STEP * (SLOTS_PER_DAY - 1)));
  return s;
}

function nextChange(d) {
  const s = slotStart(d);
  const n = new Date(s);
  const idx = (s.getHours() - FIRST_HOUR) / STEP;
  if (idx >= SLOTS_PER_DAY - 1) { n.setDate(n.getDate() + 1); n.setHours(FIRST_HOUR); }
  else n.setHours(s.getHours() + STEP);
  return n;
}

function slotNumber(d) {
  const s = slotStart(d);
  const day = Math.floor((s.getTime() - s.getTimezoneOffset() * 60000) / 86400000);
  return day * SLOTS_PER_DAY + (s.getHours() - FIRST_HOUR) / STEP;
}

async function loadWords() {
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.documentsDirectory(), 'wortkarten-widget.json');
  try {
    const req = new Request(DATA_URL + '?t=' + Date.now());
    const data = await req.loadJSON();
    fm.writeString(cache, JSON.stringify(data.words || []));
    return data.words || [];
  } catch (e) {
    return fm.fileExists(cache) ? JSON.parse(fm.readString(cache)) : null;
  }
}

function pickWords(words, now) {
  const hard = words
    .filter((w) => w.hard)
    .sort((a, b) => (a.hard === 'dk' ? 0 : 1) - (b.hard === 'dk' ? 0 : 1) || String(a.id).localeCompare(String(b.id)));
  if (hard.length <= PER_SLOT) return hard;
  const start = (slotNumber(now) * PER_SLOT) % hard.length;
  const out = [];
  for (let i = 0; i < PER_SLOT; i++) out.push(hard[(start + i) % hard.length]);
  return out;
}

function addLine(w, text, size, opts) {
  const t = w.addText(text);
  t.font = opts && opts.bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  if (opts && opts.color) t.textColor = opts.color;
  return t;
}

const now = new Date();
const words = await loadWords();
const picked = words ? pickWords(words, now) : null;
const family = config.widgetFamily || 'medium';
const w = new ListWidget();
w.refreshAfterDate = nextChange(now);

if (!picked) {
  addLine(w, 'Wortkarten: no connection', 12);
} else if (!picked.length) {
  addLine(w, 'No hard words 🎉', 13, { bold: true });
} else if (family === 'accessoryInline') {
  addLine(w, picked[0].de + ' — ' + picked[0].en, 12);
} else if (family === 'accessoryRectangular' || family === 'accessoryCircular') {
  for (const p of picked) addLine(w, p.de + ' — ' + p.en, 12);
} else {
  w.backgroundColor = Color.dynamic(new Color('#f4f3ef'), new Color('#1c1c1e'));
  const fg = Color.dynamic(new Color('#1c1c1e'), new Color('#f4f3ef'));
  const sub = Color.dynamic(new Color('#6b6b6b'), new Color('#a0a0a5'));
  addLine(w, 'WORTKARTEN', 10, { bold: true, color: sub });
  w.addSpacer(6);
  for (const p of picked) {
    addLine(w, p.de, family === 'small' ? 14 : 16, { bold: true, color: fg });
    addLine(w, p.en, family === 'small' ? 11 : 13, { color: sub });
    w.addSpacer(4);
  }
}

if (config.runsInWidget) Script.setWidget(w);
else await w.presentMedium();
Script.complete();
