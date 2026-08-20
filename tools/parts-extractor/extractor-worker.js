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
    'denv part no', 'denv partnumber', 'denv partno'],
  'Part Number DAE': ['part number', 'part number dae', 'dae part number',
    'mcq part number', 'dae p/no', 'mcq p/no', 'part number mcq', 'supplier ref',
    'part no', 'dae partno', 'mcq partno'],
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
/* No trailing \b: "Denv Partn°" contains "part" followed by a word character,
   so a closing boundary made the test miss precisely the case it exists to
   catch. Over-flagging here is harmless — this sheet is meant to be read. */
const SUSPECT_HEADER = /\b(part|number|stock|wiring|circuit|detail|item|drawing|description|critical|ref)/i;

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
    /* "n°" is the French abbreviation for "number" and turns up in headers
       written by the Belgian/French sites: "Denv Partn°", "Part n°". Folding
       it to "no" here lets the existing "denv part no" alias match, instead
       of needing one alias per punctuation variant. Both the degree sign
       (U+00B0) and the masculine ordinal (U+00BA) appear in the wild. */
    .replace(/n\s*[\u00b0\u00ba]/g, 'no')
    .replace(/[:.]+$/, '')
    .trim();
}

/* Repeated page headers often omit labels the first header carried — the
   printer only needed them at the top of the sheet. Replacing the mapping
   wholesale on every repeat therefore DROPS those columns for the rest of the
   sheet, silently: the column is in neither the descriptor mapping nor the
   model list, so its values are never read. This merges a repeat into what is
   already known, retaining a previous mapping only where the repeat leaves
   that column genuinely blank. A repeat that renames a column still wins. */
function mergeHeader(prev, next, rawRow) {
  if (!prev) return next;
  const taken = new Set(Object.values(next.mapping).concat(next.models.map((m) => m[0])));
  for (const [canon, idx] of Object.entries(prev.mapping)) {
    if (canon in next.mapping) continue;   // the repeat names it, possibly elsewhere
    if (taken.has(idx)) continue;          // that column is something else now
    const cell = rawRow[idx];
    if (cell === undefined || cell === null || String(cell).trim() === '') {
      next.mapping[canon] = idx;
      taken.add(idx);
    }
  }
  return next;
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
      const merged = mergeHeader(mapping !== null ? { mapping, models } : null, hit, rawRow);
      mapping = merged.mapping;
      models = merged.models;
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
 * 4b. Model name mapping  (MCQ -> DENV)
 *
 * The parts lists identify a unit by a column header like "MNG Mono 029.1".
 * The overview workbook maps a full MCQ model name to its DENV equivalent,
 * e.g. McEnergyMonoSE029.1ST134 -> EWAD100E-SS. The MCQ names themselves never
 * appear in the parts lists, so they have to be reconstructed from what is
 * there: the file name, the sheet name, and the column header.
 *
 * Three keys, narrowest first:
 *
 *   1. PARTS LIST NUMBER, from the file name. "n_19-McEnergy_Mono..." and
 *      "n°19-..." both give 19, which is the "Parts list n°" column in the
 *      overview. This alone cuts 2,970 rows to a few dozen and is the reason
 *      the rest can be loose without going wrong.
 *   2. CAPACITY, from the column header. "MNG Mono 029.1" -> "029.1", which
 *      must appear in the MCQ name. This is the real discriminator: it is what
 *      separates one unit from its siblings in the same family.
 *   3. EVERYTHING ELSE, scored not filtered. Alphabetic tokens from the sheet
 *      name and the header ("MONO", "SE", "ST", "LN", "MNG") are counted as
 *      substrings of the MCQ name, and the highest-scoring candidates win.
 *
 * ONE HEADER OFTEN MATCHES SEVERAL UNITS, AND THAT IS THE CORRECT ANSWER.
 * Sheet "Mono SE ST_LN" covers both the standard and low-noise variants, and
 * parts list 19 covers the condenserless (CU) units too, so "MNG Mono 029.1"
 * legitimately maps to four DENV names. The quantity in that column applies to
 * all four. Collapsing them to one would be inventing an answer, so every
 * match is listed and the count is reported alongside.
 */

function partsListNumber(fileName) {
  // "n_19-...", "n°19-...", "n 19 - ...", "19-McEnergy..." all give "19".
  const m = String(fileName).match(/^\s*(?:n\s*[_\u00b0\u00ba.\-]?\s*)?(\d{1,3})\b/i);
  return m ? String(parseInt(m[1], 10)) : null;
}

function tokens(text) {
  return (String(text).toUpperCase().match(/[A-Z]+|[0-9]+(?:\.[0-9]+)?/g) || []);
}

function isNumericToken(t) { return /^[0-9]/.test(t); }

/* Build the lookup once per run: { partsListNo: [{ mcq, mcqNorm, denv }] }. */
function buildModelMap(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const byList = new Map();
  let pairs = 0;
  for (const r of rows) {
    // Header spellings differ between revisions of the overview file.
    const no = String(r['Parts list n°'] ?? r['Parts list no'] ?? r['Parts List'] ?? '').trim();
    const mcq = String(r['MCQ-Modelname'] ?? r['MCQ Modelname'] ?? '').trim();
    const denv = String(r['DENV-Modelname'] ?? r['DENV Modelname'] ?? '').trim();
    /* Over half the overview has a DENV name and NO MCQ name — newer units
       with no McQuay equivalent. Requiring both would discard them and leave
       every parts list built on those models unmatched, so the DENV name is
       what is required and the MCQ name is a bonus. Matching then runs against
       whichever name exists, which is right either way: for a DENV-only family
       the parts list headers describe DENV units in the first place. */
    if (!denv) continue;
    if (/^no parts list/i.test(mcq)) continue;   // placeholder text, not a model
    const key = no ? String(parseInt(no, 10)) : '';
    if (!byList.has(key)) byList.set(key, []);
    const target = mcq || denv;
    byList.get(key).push({
      mcq, denv,
      mcqNorm: target.toUpperCase().replace(/[^A-Z0-9.]/g, ''),
    });
    pairs++;
  }
  return { byList, pairs };
}

/* Returns { mcq: [...], denv: [...], how: 'list+capacity' | ... }. */
function matchModels(map, fileName, sheetName, attribute) {
  if (!map) return null;

  const listNo = partsListNumber(fileName);
  let pool = listNo !== null ? (map.byList.get(listNo) || []) : [];
  let scope = 'list';
  if (!pool.length) {
    // No usable parts list number, or none of its rows survived. Searching the
    // whole table is far weaker, so it is done but labelled as such.
    pool = [].concat(...map.byList.values());
    scope = 'all lists';
  }
  if (!pool.length) return null;

  const attrTokens = tokens(attribute);
  const sheetTokens = tokens(sheetName);
  const caps = attrTokens.filter(isNumericToken);
  const words = [...attrTokens, ...sheetTokens].filter((t) => !isNumericToken(t) && t.length >= 2);

  let candidates = pool;
  let how = scope;

  if (caps.length) {
    /* The capacity must appear. Leading zeros are inconsistent between the
       header and the model name, so "29.1" and "029.1" are both tried. */
    const wanted = [];
    for (const c of caps) {
      wanted.push(c);
      const stripped = c.replace(/^0+/, '');
      if (stripped && stripped !== c) wanted.push(stripped);
      wanted.push('0' + c);
    }
    const hit = pool.filter((p) => wanted.some((w) => p.mcqNorm.includes(w)));
    if (hit.length) { candidates = hit; how = scope + '+capacity'; }
    else return { mcq: [], denv: [], how: 'no capacity match', count: 0 };
  }

  // Score on the remaining words; keep every candidate on the top score.
  let bestScore = -1;
  const scored = candidates.map((p) => {
    let sc = 0;
    for (const w of words) if (p.mcqNorm.includes(w)) sc++;
    if (sc > bestScore) bestScore = sc;
    return { p, sc };
  });
  const winners = scored.filter((x) => x.sc === bestScore).map((x) => x.p);

  return {
    mcq: winners.map((p) => p.mcq),
    denv: winners.map((p) => p.denv),
    how: bestScore > 0 ? how + '+name' : how,
    count: winners.length,
  };
}

/* ------------------------------------------------------------------ *
 * 5. Driver
 * ------------------------------------------------------------------ */
const COLS = ['Source File', 'Sheet', 'Section', ...DESCRIPTOR_ORDER, 'Attribute', 'Value'];
const MAP_COLS = ['MCQ-Modelname', 'DENV-Modelname', 'Model Match'];

function aoaFromObjects(objs, cols) {
  const out = [cols];
  for (const o of objs) out.push(cols.map((c) => (o[c] === undefined ? '' : o[c])));
  return out;
}

self.onmessage = async (e) => {
  const { files, keepDash, mapFile } = e.data;
  const started = Date.now();

  try {
    /* Optional overview workbook. Without it the tool behaves exactly as
       before and the three mapping columns are simply absent. */
    let modelMap = null;
    let mapNote = '';
    if (mapFile && mapFile.buffer && mapFile.buffer.byteLength) {
      try {
        const mwb = XLSX.read(mapFile.buffer, { type: 'array' });
        modelMap = buildModelMap(mwb.Sheets[mwb.SheetNames[0]]);
        mapNote = `${modelMap.pairs} model pairs from ${mapFile.name}`;
        if (!modelMap.pairs) { modelMap = null; mapNote = `no MCQ/DENV pairs found in ${mapFile.name}`; }
      } catch (err) {
        modelMap = null;
        mapNote = `could not read ${mapFile.name}: ${err.message}`;
      }
    }
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

    /* --- model name mapping ---------------------------------------------
       Matching is per distinct file + sheet + column header, not per row: a
       sheet with 1,650 rows has ten distinct headers, so this runs ten times
       rather than 1,650. */
    const mapCache = new Map();
    const mapAudit = new Map();
    if (modelMap) {
      for (const r of rows) {
        const key = `${r['Source File']}\u0001${r['Sheet']}\u0001${r['Attribute']}`;
        let hit = mapCache.get(key);
        if (hit === undefined) {
          hit = matchModels(modelMap, r['Source File'], r['Sheet'], r['Attribute']);
          mapCache.set(key, hit);
          mapAudit.set(key, {
            'Source File': r['Source File'], 'Sheet': r['Sheet'], 'Attribute': r['Attribute'],
            'Matches': hit ? hit.count : 0,
            'MCQ-Modelname': hit ? hit.mcq.join(' / ') : '',
            'DENV-Modelname': hit ? hit.denv.join(' / ') : '',
            'Model Match': hit ? hit.how : 'no map',
          });
        }
        r['MCQ-Modelname'] = hit ? hit.mcq.join(' / ') : '';
        r['DENV-Modelname'] = hit ? hit.denv.join(' / ') : '';
        r['Model Match'] = hit ? `${hit.count} · ${hit.how}` : 'no match';
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
    const outCols = rows.length
      ? [...COLS, 'Attribute Raw', ...(modelMap ? MAP_COLS : [])]
      : COLS;
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
    if (mapAudit.size) {
      /* One row per column header rather than per data row: this is the sheet
         to eyeball once to confirm the matching is sane, and it is a few dozen
         rows rather than tens of thousands. */
      XLSX.utils.book_append_sheet(wbOut,
        XLSX.utils.aoa_to_sheet(aoaFromObjects([...mapAudit.values()],
          ['Source File', 'Sheet', 'Attribute', 'Matches', 'MCQ-Modelname', 'DENV-Modelname', 'Model Match'])),
        'QA_Model_Map');
    }

    const buf = XLSX.write(wbOut, { bookType: 'xlsx', type: 'array' });

    self.postMessage({
      type: 'done',
      buffer: buf,
      rowCount: rows.length,
      log,
      flagCount: flags.size,
      renameCount: renames.size,
      mapNote,
      mapped: mapAudit.size ? [...mapAudit.values()].filter((a) => a.Matches > 0).length : 0,
      mapTotal: mapAudit.size,
      ms: Date.now() - started,
    }, [buf]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
