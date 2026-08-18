/* Parts list extractor — worker.
 *
 * A direct port of extract_parts_lists.py. The Python tool is the reference
 * implementation and the rules below are its rules, deliberately unchanged:
 * the same header dictionary, the same header/title/section tests, the same
 * fill-down set, the same model-code canonicalisation. Where this file departs
 * from the Python it is noted inline.
 *
 * It runs in a worker because parsing ten workbooks and writing sixty-odd
 * thousand rows is seconds of solid CPU. On the main thread that is a frozen
 * tab with no progress and no way out.
 *
 * Classic worker, not a module: SheetJS is loaded with importScripts, which
 * module workers do not have.
 */
/* global XLSX */
importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');

/* ------------------------------------------------------------------ *
 * 1. Config — the header dictionary.
 *
 * Anything NOT listed here is treated as a model column, so new model
 * codes need no change. To support a new spelling, add one alias.
 * ------------------------------------------------------------------ */
const HEADER_ALIASES = {
  'Item': ['item', 'item no', 'item number'],
  'Drawing': ['drawing', 'drawing no', 'drawing ref'],
  'Description': ['description', 'part description'],
  'Part Number DENV': ['denv part number', 'part number denv', 'denv p/no',
    'denv part no', 'denv partnumber'],
  'Part Number DAE': ['part number', 'part number dae', 'dae part number',
    'mcq part number', 'dae p/no', 'mcq p/no', 'part number mcq', 'supplier ref'],
  'Details': ['details', 'detail', 'remarks'],
  'Circuit': ['circuit', 'circuit no'],
  'Wiring Diagram Reference': ['wiring diagram reference', 'wiring diagram',
    'wiring diagram ref', 'wiring ref'],
  'Stock Criticality': ['critical stock item?', 'critical stock item',
    'stock criticality', 'criticality', 'critical stock', 'stock critical item?'],
};

const LOOKUP = {};
for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
  for (const a of aliases) LOOKUP[a] = canon;
}
/* Second-pass lookup ignoring spaces, matching the Python fuzzy pass. */
const LOOKUP_TIGHT = {};
for (const [alias, canon] of Object.entries(LOOKUP)) {
  LOOKUP_TIGHT[alias.replace(/ /g, '')] = canon;
}

const DESCRIPTOR_ORDER = ['Item', 'Drawing', 'Part Number DENV', 'Description',
  'Part Number DAE', 'Details', 'Circuit', 'Wiring Diagram Reference',
  'Stock Criticality'];

const FILL_DOWN = ['Item', 'Drawing', 'Description', 'Circuit'];
const MIN_MODEL_COLS = 1;
const MAX_COLS = 256;

const SHEET_BLACKLIST = ['front page', 'back page', 'index', 'drawings', 'revision',
  'nomenclature', 'conversion table', 'options list', 'electrical legend'];

const TITLE_PAT = /^(page\s*\d+|issue\s*\d+|.*\bissue\s*\d+)/i;
const NOISE_PAT = /quantity for each/i;
const SUSPECT_HEADER = /\b(part|number|stock|wiring|circuit|detail|item|drawing|description|critical|ref)\b/i;

/* ------------------------------------------------------------------ *
 * 2. Reading — one uniform grid of strings, merges expanded.
 * ------------------------------------------------------------------ */
function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (v instanceof Date) {
    // Match the Python isoformat() output for date cells.
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const t = `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
    return t === '00:00:00' ? base : `${base}T${t}`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).replace(/\s+/g, ' ').trim();
}

/* Returns { grid, raw }.
   `raw` has merged values only in the top-left cell, as the file stores them,
   and is what the header / title / section tests read — exactly as in the
   Python, where those tests run against the unexpanded row.
   `grid` has every merged region filled across, and is what values are taken
   from. Keeping both is what makes "1pc per compressor" spanning six model
   columns land in all six without a heuristic. */
function readGrid(ws) {
  const rowsRaw = XLSX.utils.sheet_to_json(ws, {
    header: 1, raw: true, defval: null, blankrows: true,
  });

  const grid = [];
  for (const row of rowsRaw) {
    const cells = (row || []).map(fmt);
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    grid.push(cells.slice(0, MAX_COLS));
  }
  let ncol = 0;
  for (const r of grid) ncol = Math.max(ncol, r.length);
  for (const r of grid) while (r.length < ncol) r.push('');

  const raw = grid.map((r) => r.slice());

  for (const m of (ws['!merges'] || [])) {
    const r1 = m.s.r; const c1 = m.s.c; const r2 = m.e.r; const c2 = m.e.c;
    if (r1 >= grid.length || c1 >= ncol) continue;
    const val = grid[r1][c1];
    if (val === '') continue;
    for (let r = r1; r <= Math.min(r2, grid.length - 1); r++) {
      for (let c = c1; c <= Math.min(c2, ncol - 1); c++) grid[r][c] = val;
    }
  }
  return { grid, raw };
}

/* ------------------------------------------------------------------ *
 * 3. Structure detection
 * ------------------------------------------------------------------ */
function norm(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[:.]+$/, '')
    .trim();
}

function classifyHeader(row) {
  const mapping = {};
  const models = [];
  for (let idx = 0; idx < row.length; idx++) {
    const n = norm(row[idx]);
    if (!n) continue;
    let canon = LOOKUP[n];
    if (canon === undefined) canon = LOOKUP_TIGHT[n.replace(/ /g, '')];
    if (canon !== undefined) {
      if (!(canon in mapping)) mapping[canon] = idx;
    } else {
      models.push([idx, String(row[idx]).replace(/\s+/g, ' ').trim()]);
    }
  }
  const ok = ('Description' in mapping)
    && (('Part Number DENV' in mapping) || ('Part Number DAE' in mapping))
    && models.length >= MIN_MODEL_COLS;
  return ok ? { mapping, models } : null;
}

function isTitleRow(rawRow) {
  const vals = rawRow.filter((v) => v);
  if (!vals.length) return true;
  if (NOISE_PAT.test(vals.join(' '))) return true;
  if (TITLE_PAT.test(norm(vals[0])) && new Set(vals).size <= 4) return true;
  return false;
}

function isSectionRow(rawRow, mapping, models) {
  const filled = [];
  for (let i = 0; i < rawRow.length; i++) if (rawRow[i]) filled.push(i);
  if (!filled.length) return false;

  for (const k of ['Description', 'Part Number DENV', 'Part Number DAE']) {
    const i = mapping[k];
    if (i !== undefined && i < rawRow.length && rawRow[i]) return false;
  }
  for (const [i] of models) if (i < rawRow.length && rawRow[i]) return false;
  return Boolean(rawRow[filled[0]]) && filled[0] <= 2;
}

/* ------------------------------------------------------------------ *
 * 4. Sheet -> long rows
 * ------------------------------------------------------------------ */
function extractSheet(ws, fileName, sheetName, keepDash) {
  const { grid, raw } = readGrid(ws);
  if (!grid.length) return { rows: [], headerVariants: 0 };

  let mapping = null;
  let models = null;
  let section = '';
  let last = {};
  for (const k of FILL_DOWN) last[k] = '';
  const out = [];
  let headerVariants = 0;

  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    const rawRow = raw[r];

    const hit = classifyHeader(rawRow);
    if (hit) {
      // First header, or a repeated page header. A repeat with a different
      // model list means the sheet changes layout partway down.
      const before = models ? models.map((x) => x[1]).join('\u0001') : null;
      const after = hit.models.map((x) => x[1]).join('\u0001');
      if (mapping === null || before !== after) headerVariants++;
      mapping = hit.mapping;
      models = hit.models;
      last = {};
      for (const k of FILL_DOWN) last[k] = '';
      continue;
    }
    if (mapping === null) continue;
    if (isTitleRow(rawRow)) continue;
    if (isSectionRow(rawRow, mapping, models)) {
      const first = rawRow.findIndex((v) => v);
      section = rawRow[first];
      continue;
    }

    const rec = {};
    for (const canon of DESCRIPTOR_ORDER) {
      const i = mapping[canon];
      rec[canon] = (i !== undefined && i < row.length) ? row[i] : '';
    }
    for (const k of FILL_DOWN) {
      if (rec[k]) last[k] = rec[k];
      else rec[k] = last[k] || '';
    }

    if (!(rec['Description'] || rec['Part Number DENV'] || rec['Part Number DAE'])) continue;

    const qty = models.map(([i, name]) => [name, i < row.length ? row[i] : '']);
    if (!qty.some(([, v]) => v)) continue;   // no quantities at all -> noise

    for (const [name, val] of qty) {
      if (val === '') continue;
      if (!keepDash && (val.trim() === '-' || val.trim() === '0')) continue;
      out.push({
        'Source File': fileName,
        'Sheet': sheetName,
        'Section': section,
        ...rec,
        'Attribute': name,
        'Value': val,
      });
    }
  }
  return { rows: out, headerVariants };
}

/* ------------------------------------------------------------------ *
 * 5. Driver
 * ------------------------------------------------------------------ */
const COLS = ['Source File', 'Sheet', 'Section', ...DESCRIPTOR_ORDER, 'Attribute', 'Value'];

function aoaFromObjects(objs, cols) {
  const out = [cols];
  for (const o of objs) out.push(cols.map((c) => (o[c] === undefined ? '' : o[c])));
  return out;
}

self.onmessage = async (e) => {
  const { files, keepDash } = e.data;
  const started = Date.now();

  try {
    const rows = [];
    const log = [];
    let done = 0;
    const totalUnits = files.length;

    for (const f of files) {
      let wb;
      try {
        // cellDates so date cells arrive as Date, matching the Python.
        wb = XLSX.read(f.buffer, { type: 'array', cellDates: true, dense: false });
      } catch (err) {
        log.push({ 'Source File': f.name, 'Sheet': '', 'Rows': 0, 'Status': `OPEN FAILED: ${err.message}` });
        done++;
        self.postMessage({ type: 'progress', fraction: done / totalUnits, label: f.name });
        continue;
      }

      for (const sheetName of wb.SheetNames) {
        const lower = sheetName.toLowerCase();
        if (SHEET_BLACKLIST.some((b) => lower.includes(b))) {
          log.push({ 'Source File': f.name, 'Sheet': sheetName, 'Rows': 0, 'Status': 'skipped (blacklist)' });
          continue;
        }
        try {
          const { rows: recs, headerVariants } = extractSheet(wb.Sheets[sheetName], f.name, sheetName, keepDash);
          if (recs.length) {
            for (const r of recs) rows.push(r);
            log.push({ 'Source File': f.name, 'Sheet': sheetName, 'Rows': recs.length, 'Status': `ok (${headerVariants} header layout(s))` });
          } else {
            log.push({ 'Source File': f.name, 'Sheet': sheetName, 'Rows': 0, 'Status': 'no parts table found' });
          }
        } catch (err) {
          log.push({ 'Source File': f.name, 'Sheet': sheetName, 'Rows': 0, 'Status': `ERROR: ${err.message}` });
        }
      }
      done++;
      self.postMessage({ type: 'progress', fraction: done / totalUnits, label: f.name });
    }

    /* --- canonicalise model codes: "MNG171.2 Econ" -> "MNG 171.2 Econ" ---
       Codes are keyed on their letters and digits alone, and the spelling
       from the FIRST time that key appears wins. Repeated page headers often
       carry typos, and the top-of-sheet header is the reliable one. */
    const best = new Map();
    for (const r of rows) {
      const key = String(r['Attribute']).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!best.has(key)) best.set(key, r['Attribute']);
    }
    const renames = new Map();
    for (const r of rows) {
      const key = String(r['Attribute']).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const canon = best.get(key);
      r['Attribute Raw'] = r['Attribute'];
      if (canon && canon !== r['Attribute']) {
        renames.set(`${r['Source File']}\u0001${r['Sheet']}\u0001${r['Attribute']}\u0001${canon}`, {
          'Source File': r['Source File'], 'Sheet': r['Sheet'],
          'Attribute Raw': r['Attribute'], 'Attribute': canon,
        });
        r['Attribute'] = canon;
      }
    }

    /* Headers treated as models that may really be descriptors — the early
       warning that a workbook uses a spelling the dictionary does not know. */
    const flags = new Map();
    for (const r of rows) {
      if (SUSPECT_HEADER.test(r['Attribute'])) {
        flags.set(`${r['Source File']}\u0001${r['Attribute']}`, {
          'Source File': r['Source File'], 'Unrecognised header': r['Attribute'],
        });
      }
    }

    /* Model summary: rows per file / sheet / model. */
    const summary = new Map();
    for (const r of rows) {
      const k = `${r['Source File']}\u0001${r['Sheet']}\u0001${r['Attribute']}`;
      const cur = summary.get(k);
      if (cur) cur.Rows++;
      else summary.set(k, { 'Source File': r['Source File'], 'Sheet': r['Sheet'], 'Attribute': r['Attribute'], 'Rows': 1 });
    }

    self.postMessage({ type: 'progress', fraction: 1, label: 'Writing the workbook' });

    const wbOut = XLSX.utils.book_new();
    const outCols = rows.length ? [...COLS, 'Attribute Raw'] : COLS;
    XLSX.utils.book_append_sheet(wbOut,
      XLSX.utils.aoa_to_sheet(aoaFromObjects(rows, outCols)), 'Parts_Long');
    XLSX.utils.book_append_sheet(wbOut,
      XLSX.utils.aoa_to_sheet(aoaFromObjects(log, ['Source File', 'Sheet', 'Rows', 'Status'])), 'Extraction_Log');
    if (flags.size) {
      XLSX.utils.book_append_sheet(wbOut,
        XLSX.utils.aoa_to_sheet(aoaFromObjects([...flags.values()], ['Source File', 'Unrecognised header'])), 'QA_Check_Headers');
    }
    if (renames.size) {
      XLSX.utils.book_append_sheet(wbOut,
        XLSX.utils.aoa_to_sheet(aoaFromObjects([...renames.values()], ['Source File', 'Sheet', 'Attribute Raw', 'Attribute'])), 'QA_Model_Renames');
    }
    if (rows.length) {
      XLSX.utils.book_append_sheet(wbOut,
        XLSX.utils.aoa_to_sheet(aoaFromObjects([...summary.values()], ['Source File', 'Sheet', 'Attribute', 'Rows'])), 'Model_Summary');
    }

    const buf = XLSX.write(wbOut, { bookType: 'xlsx', type: 'array' });

    self.postMessage({
      type: 'done',
      buffer: buf,
      rowCount: rows.length,
      log,
      flagCount: flags.size,
      renameCount: renames.size,
      ms: Date.now() - started,
    }, [buf]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
