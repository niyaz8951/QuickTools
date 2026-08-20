/* =====================================================================
   Compliance Maker — static build

   Specification PDF (or pasted text) -> numbered compliance matrix -> .xlsx.
   Everything runs in the browser: the PDF is read with pdf.js locally and the
   workbook is written by xlsx-writer.js, so no file ever leaves the machine.

   This is the conversion engine only. The parser, the highlighter and the
   preview renderer are carried over unchanged from the full tool so the rows
   and the exported formatting are identical; the library matching, answer log,
   conflict checks and AI review are absent because they need a database and a
   server, and this build has neither.

   One deliberate difference from the full tool: the highlight rules load from
   data/highlight-rules.json instead of an .xlsx. The full tool reads the
   workbook with SheetJS, and shipping a 900 KB spreadsheet parser to read one
   list of words is not a trade worth making on a static host.
   ===================================================================== */
(function () {
  'use strict';

  /* ---- PDF.js worker ---- */
  if (window['pdfjsLib']) {
    window['pdfjsLib'].GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ---- Element refs ---- */
  var dropzone   = document.getElementById('dropzone');
  var fileInput  = document.getElementById('file-input');
  var fileSlot   = document.getElementById('file-slot');
  var statusEl   = document.getElementById('status');
  var resultPanel= document.getElementById('result-panel');
  var previewBody= document.getElementById('preview-body');
  var countNote  = document.getElementById('count-note');
  var btnDownload= document.getElementById('btn-download');
  var btnClear   = document.getElementById('btn-clear');
  var dictEl     = document.getElementById('dict');
  var hlNumbers  = document.getElementById('hl-numbers');
  var hlCaps     = document.getElementById('hl-caps');
  var dbRulesOn  = document.getElementById('hl-db-rules');
  var tabPdf     = document.getElementById('tab-pdf');
  var tabText    = document.getElementById('tab-text');
  var panePdf    = document.getElementById('pane-pdf');
  var paneText   = document.getElementById('pane-text');
  var pasteInput = document.getElementById('paste-input');
  var btnConvert = document.getElementById('btn-convert');
  var convertHint= document.getElementById('convert-hint');
  var pageLimitNote = document.getElementById('page-limit-note');

  var currentRows = null;
  var currentName = 'compliance-matrix';
  var pendingFile = null;          // chosen PDF, not yet processed
  var activeSource = 'pdf';        // 'pdf' | 'text'

  /* Page ceiling. Nothing enforces this but this line — there is no server to
     disagree with it. It exists to stop a 400-page spec locking up the tab,
     not to ration anything. */
  var MAX_PAGES = 50;
  var CHARS_PER_PAGE = 3000;

  /* ======================================================================
     PARSER — lines to classified rows.
     ====================================================================== */

  var RE = {
    part:    /^(PART\s+[0-9IVX]+)\b\s*(.*)$/i,
    section: /^(\d{1,2}\.\d{1,2})\s+(.*)$/,        // 1.01, 1.1, 2.1, 1.3
    number:  /^(\d{1,2})\.\s+(.*)$/,               // 1.
    letter:  /^([A-Z])\.\s+(.*)$/,                 // A.
    letterLoose: /^([a-zA-Z])[.)]\s+(.*)$/
  };

  // Mirrors the Excel tool's section test: a numbered heading is a blue
  // SECTION when its text is short and heading-shaped (Proper Case, ALL CAPS,
  // "CAPS-word + Proper rest", or ends with ":"). Otherwise it's a body row
  // (e.g. "1.1 The unit shall...") so it doesn't wrongly turn blue.
  function isSectionHeading(text) {
    if (!text) return true;                 // bare "1.3" with title on next line
    var words = text.split(/\s+/);
    if (words.length > 6) return false;      // long sentence -> not a heading
    if (/[.]/.test(text.replace(/:$/, ''))) return false; // decimals/periods inside -> not heading
    var stripped = text.replace(/:$/, '');
    var isCaps = stripped === stripped.toUpperCase();
    var isProper = words.every(function (w) {
      return !w || w[0] === w[0].toUpperCase();
    });
    var endsColon = /:$/.test(text);
    return isCaps || isProper || endsColon;
  }

  function startsNewItem(line) {
    return RE.part.test(line) || RE.section.test(line) ||
           RE.number.test(line) || RE.letter.test(line) ||
           RE.letterLoose.test(line);
  }

  function classify(line) {
    var m;
    if ((m = line.match(RE.part)))    return { type: 'part',    sr: m[1].toUpperCase(), spec: (m[2] || '').trim() };
    if ((m = line.match(RE.section))) {
      var stext = m[2].trim();
      // x.xx (two-decimal) is always a section (classic spec numbering).
      // x.x (one-decimal) is a section only if it reads like a heading.
      var twoDecimal = /^\d{1,2}\.\d{2}$/.test(m[1]);
      if (twoDecimal || isSectionHeading(stext)) {
        return { type: 'section', sr: m[1], spec: stext };
      }
      // Otherwise treat as a normal numbered body clause.
      return { type: 'number', sr: m[1], spec: stext };
    }
    if ((m = line.match(RE.number)))  return { type: 'number',  sr: m[1], spec: m[2].trim() };
    if ((m = line.match(RE.letter)))  return { type: 'letter',  sr: m[1], spec: m[2].trim() };
    if ((m = line.match(RE.letterLoose))) return { type: 'letter', sr: m[1], spec: m[2].trim() };
    return { type: 'text', sr: '', spec: line.trim() };
  }

  // "END OF SECTION" closes a specification section. It is a divider, not a
  // clause — but it arrives at the tail of the last clause's line, where the
  // continuation rule would silently glue it onto that clause's text. So it
  // is split off first and emitted as its own black band row, the same
  // treatment a PART header gets.
  var END_OF_SECTION_RE = /\bend\s+of\s+section\b[.:\s]*$/i;

  function parseLines(rawLines) {
    var rows = [];
    for (var i = 0; i < rawLines.length; i++) {
      var line = rawLines[i].replace(/\s+/g, ' ').trim();
      if (!line) continue;

      var endMatch = line.match(END_OF_SECTION_RE);
      if (endMatch) {
        // Whatever came before it on the same line is still a real clause,
        // so process that remainder first and let the divider follow.
        var before = line.slice(0, endMatch.index).trim();
        if (before) {
          rawLines.splice(i + 1, 0, 'END OF SECTION');
          line = before;
        } else {
          rows.push({ type: 'part', sr: '', spec: 'END OF SECTION' });
          continue;
        }
      }

      if (startsNewItem(line)) {
        rows.push(classify(line));
      } else if (rows.length &&
                 rows[rows.length - 1].type !== 'part' &&
                 rows[rows.length - 1].type !== 'section') {
        // Wrapped continuation of the previous clause — append.
        rows[rows.length - 1].spec =
          (rows[rows.length - 1].spec + ' ' + line).trim();
      } else {
        // Unlabeled paragraph directly after a PART/section header (or at
        // the start) is its own body row — headers never absorb body text.
        rows.push({ type: 'text', sr: '', spec: line });
      }
    }
    rows.forEach(function (r) {
      if (r.type === 'part') {
        r.spec = (r.sr + (r.spec ? ' ' + r.spec : '')).trim();
        r.sr = '';
      }
    });
    return rows;
  }

  /* ======================================================================
     HIGHLIGHTING — three styles (red, red+bold, underline) driven by a
     shared rules file PLUS user words. Users can add extra red words in
     the Keyword dictionary box.
     ====================================================================== */

  var RULES_URL = '../../data/highlight-rules.json';
  var rulesCache = null;   // { red:[], redbold:[], underline:[] } lowercased phrase lists

  function loadRules() {
    if (rulesCache) return Promise.resolve(rulesCache);
    return fetch(RULES_URL).then(function (r) {
      if (!r.ok) throw new Error('rules not found');
      return r.json();
    }).then(function (data) {
      rulesCache = {
        red: data.red || [],
        redbold: data.redbold || [],
        underline: data.underline || []
      };
      return rulesCache;
    }).catch(function () {
      // A missing rules file must not stop a conversion — the user's own
      // dictionary and the number/caps toggles still work.
      rulesCache = { red: [], redbold: [], underline: [] };
      return rulesCache;
    });
  }

  function getDictionary() {
    return dictEl.value
      .split(/[\n,]/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Build the active highlighter from: rules file (if loaded) + user words +
  // the number/ALL-CAPS checkboxes. Every matchable item is tagged with the
  // style it should get. Longer phrases win over shorter, style precedence
  // redbold > underline > red for single tokens.
  function buildHighlighter() {
    var rules = rulesCache || { red: [], redbold: [], underline: [] };
    var useDb = dbRulesOn && dbRulesOn.checked;

    // Word -> style map (single tokens), and phrase list with styles.
    var wordStyle = {};
    var phrases = [];   // { re-safe text, style }

    function add(list, style) {
      list.forEach(function (item) {
        if (/\s/.test(item)) phrases.push({ text: item, style: style });
        else wordStyle[item.toLowerCase()] = wordStyle[item.toLowerCase()] || style;
      });
    }
    if (useDb) {
      // precedence: redbold first so it wins the word map
      add(rules.redbold, 'redbold');
      add(rules.underline, 'underline');
      add(rules.red, 'red');
    }
    // User-typed words are always red (simple), and always applied.
    add(getDictionary(), 'red');

    var doNumbers = hlNumbers.checked;
    var doCaps = hlCaps.checked;

    var hasAny = phrases.length || Object.keys(wordStyle).length || doNumbers || doCaps;
    if (!hasAny) return null;

    // Longest phrases first so multi-word locks beat their sub-words.
    phrases.sort(function (a, b) { return b.text.length - a.text.length; });
    return { wordStyle: wordStyle, phrases: phrases, doNumbers: doNumbers, doCaps: doCaps, hasRules: true };
  }

  function tokenStyle(tok, hl) {
    if (!hl) return '';
    var low = tok.toLowerCase();
    if (hl.wordStyle[low]) return hl.wordStyle[low];
    if (hl.doNumbers && /^\d+(?:\.\d+)?$/.test(tok)) return 'red';
    if (hl.doCaps && /^[A-Z][A-Z0-9&/-]*[A-Z0-9]$|^[A-Z]{2,}$/.test(tok)) return 'red';
    return '';
  }

  // Returns runs of { text, style } where style is
  // '' | 'red' | 'redbold' | 'underline' | 'colon' (brown bold prefix).
  function splitRuns(text, hl) {
    if (!text) return [{ text: text, style: '' }];

    // Colon-prefix rule (from the Excel tool): if the line contains ":" and
    // the part up to and including it is < 40 chars, that prefix is brown+bold.
    // This runs even when no other highlighter is active.
    var colonEnd = 0;
    var ci = text.indexOf(':');
    if (ci > 0 && ci < 40) colonEnd = ci + 1;

    if (!hl || !hl.hasRules) {
      if (!colonEnd) return [{ text: text, style: '' }];
      return [{ text: text.slice(0, colonEnd), style: 'colon' },
              { text: text.slice(colonEnd), style: '' }];
    }

    // Lock phrase spans with their style (longest-first already sorted).
    var locked = [];  // { a, b, style }
    hl.phrases.forEach(function (p) {
      var re = new RegExp('\\b' + escapeRegex(p.text) + '\\b', 'gi');
      var m;
      while ((m = re.exec(text)) !== null) {
        var a = m.index, b = m.index + m[0].length;
        var overlap = locked.some(function (L) { return a < L.b && b > L.a; });
        if (!overlap) locked.push({ a: a, b: b, style: p.style });
      }
    });
    function lockedAt(i) {
      // Colon prefix wins over other rules for its span.
      if (colonEnd && i < colonEnd) return 'colon';
      for (var k = 0; k < locked.length; k++) if (i >= locked[k].a && i < locked[k].b) return locked[k].style;
      return null;
    }

    var runs = [];
    var re = /[A-Za-z0-9][A-Za-z0-9&/.-]*|[^A-Za-z0-9]+/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var tok = m[0];
      var lockStyle = lockedAt(m.index);
      var isWord = /[A-Za-z0-9]/.test(tok[0]);
      var style;
      if (lockStyle) style = lockStyle;
      else if (isWord) style = tokenStyle(tok.replace(/\.+$/, ''), hl);
      else style = '';
      if (runs.length && runs[runs.length - 1].style === style) runs[runs.length - 1].text += tok;
      else runs.push({ text: tok, style: style });
    }
    return runs.length ? runs : [{ text: text, style: '' }];
  }

  /* ======================================================================
     PREVIEW
     ====================================================================== */

  function renderPreview(rows) {
    var re = buildHighlighter();
    previewBody.innerHTML = '';
    var blanks = 0;

    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      if (r.type === 'part')    tr.className = 'row-part';
      if (r.type === 'section') tr.className = 'row-section';

      var srTd = document.createElement('td');
      srTd.className = 'sr';
      if (r.type === 'letter') srTd.classList.add('lvl-letter');
      if (r.type === 'number') srTd.classList.add('lvl-number');
      srTd.textContent = r.sr || '';
      tr.appendChild(srTd);

      var specTd = document.createElement('td');
      if (r.type === 'part' || r.type === 'section') {
        specTd.textContent = r.spec;
      } else {
        splitRuns(r.spec, re).forEach(function (run) {
          if (run.style) {
            var span = document.createElement('span');
            span.className = 'hl hl-' + run.style;
            span.textContent = run.text;
            specTd.appendChild(span);
          } else {
            specTd.appendChild(document.createTextNode(run.text));
          }
        });
      }
      tr.appendChild(specTd);

      // Compliance and Remarks are always the engineer's to fill in.
      var isBody = (r.type === 'letter' || r.type === 'number' || r.type === 'text');
      if (isBody) blanks++;
      [0, 1].forEach(function () {
        var td = document.createElement('td');
        td.className = 'col-empty';
        tr.appendChild(td);
      });

      var cTd = document.createElement('td');
      cTd.className = 'comments';
      if (r.type === 'part') cTd.style.background = '#000';
      tr.appendChild(cTd);

      previewBody.appendChild(tr);
    });

    countNote.textContent = rows.length + ' rows' +
      (blanks ? ' · ' + blanks + ' to fill in' : '') + '.';
    resultPanel.hidden = false;
    btnDownload.disabled = rows.length === 0;
  }

  /* ======================================================================
     PDF READING
     ====================================================================== */

  function extractLinesFromTextContent(tc) {
    var items = tc.items.filter(function (it) { return it.str !== undefined; });
    var lines = [];
    var currentY = null, buf = [];
    items.forEach(function (it) {
      var y = it.transform[5];
      if (currentY === null || Math.abs(y - currentY) <= 2) {
        buf.push(it.str);
        currentY = currentY === null ? y : currentY;
      } else {
        lines.push(buf.join(''));
        buf = [it.str];
        currentY = y;
      }
    });
    if (buf.length) lines.push(buf.join(''));
    return lines;
  }

  /* ======================================================================
     BUILD
     ====================================================================== */

  function finishBuild(rows, baseMsg) {
    currentRows = rows;
    renderPreview(rows);
    setStatus(baseMsg + '.', 'ok');
  }

  // Selecting a file only STORES it. Nothing is parsed until Convert.
  function selectFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setStatus('That is not a PDF. Please choose a .pdf file.', 'error');
      return;
    }
    pendingFile = file;
    currentName = file.name.replace(/\.pdf$/i, '') || 'compliance-matrix';
    showFileTag(file.name);
    setStatus('');
    refreshConvertState();
  }

  // Convert-triggered: read the stored PDF, parse, then finishBuild.
  function processPdf() {
    var file = pendingFile;
    if (!window['pdfjsLib']) {
      setStatus('PDF engine failed to load. Check your connection and refresh.', 'error');
      return;
    }
    setStatus('Reading PDF…');
    btnDownload.disabled = true;
    setConverting(true);

    var reader = new FileReader();
    reader.onload = function () {
      var task = window['pdfjsLib'].getDocument({ data: new Uint8Array(reader.result) });
      task.promise.then(function (pdf) {
        var maxPages = Math.min(pdf.numPages, MAX_PAGES);
        var allLines = [];

        function readPage(p) {
          if (p > maxPages) return Promise.resolve();
          setStatus('Reading page ' + p + ' of ' + maxPages + '…');
          return pdf.getPage(p)
            .then(function (page) { return page.getTextContent(); })
            .then(function (tc) {
              allLines = allLines.concat(extractLinesFromTextContent(tc));
              return new Promise(function (r) { setTimeout(r, 0); });
            })
            .then(function () { return readPage(p + 1); });
        }

        return readPage(1).then(function () {
          var joined = allLines.join('').trim();
          if (!joined) {
            setStatus('No selectable text found. This looks like a scanned PDF — OCR is not supported.', 'error');
            resultPanel.hidden = true;
            setConverting(false);
            return;
          }
          setStatus('Building matrix…');
          var rows = parseLines(allLines);
          var note = pdf.numPages > MAX_PAGES
            ? ' (first ' + MAX_PAGES + ' of ' + pdf.numPages + ' pages)'
            : '';
          finishBuild(rows, 'Done — ' + rows.length + ' rows' + note);
          setConverting(false);
        });
      }).catch(function (err) {
        console.error(err);
        setStatus('Could not read that PDF. It may be corrupted or password-protected.', 'error');
        setConverting(false);
      });
    };
    reader.onerror = function () { setStatus('Could not read the file.', 'error'); setConverting(false); };
    reader.readAsArrayBuffer(file);
  }

  // THE single entry point. Nothing above runs until this is clicked.
  //
  // The rules file is warmed at startup, but a fast paste-and-click can still
  // beat the fetch. Converting then silently produces a matrix with no bold
  // and no underline — a wrong result that looks like a right one. So the
  // rules are awaited here; loadRules() resolves instantly once cached, and
  // resolves to empty lists if the file is missing, so this never hangs.
  function runConvert() {
    loadRules().then(doConvert);
  }

  function doConvert() {
    if (activeSource === 'pdf') {
      if (!pendingFile) { setStatus('Choose a PDF first.', 'error'); return; }
      processPdf();
    } else {
      var raw = pasteInput.value;
      if (!raw || !raw.trim()) { setStatus('Paste some specification text first.', 'error'); return; }
      // Pasted text has no pages to count, so the same ceiling is applied by
      // character budget instead — CHARS_PER_PAGE is a deliberate,
      // conservative stand-in for a spec page of body text.
      var cap = MAX_PAGES * CHARS_PER_PAGE;
      var trimmed = '';
      if (raw.length > cap) {
        raw = raw.slice(0, cap);
        trimmed = ' (trimmed to the first ~' + MAX_PAGES + ' pages of text)';
      }
      currentName = 'compliance-matrix';
      setConverting(true);
      var rows = parseLines(raw.split(/\r\n|\r|\n/));
      finishBuild(rows, 'Done — ' + rows.length + ' rows' + trimmed);
      setConverting(false);
    }
  }

  /* ======================================================================
     UI GLUE
     ====================================================================== */

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' status--' + kind : '');
  }

  function showFileTag(name) {
    fileSlot.innerHTML = '';
    var tag = document.createElement('span');
    tag.className = 'file-tag';
    tag.appendChild(document.createTextNode(name));
    var x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Remove file');
    x.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    x.addEventListener('click', clearAll);
    tag.appendChild(x);
    fileSlot.appendChild(tag);
  }

  function clearAll() {
    currentRows = null;
    pendingFile = null;
    fileInput.value = '';
    fileSlot.innerHTML = '';
    previewBody.innerHTML = '';
    resultPanel.hidden = true;
    btnDownload.disabled = true;
    setStatus('');
    refreshConvertState();
  }

  // Convert is enabled when there is something to convert.
  function refreshConvertState() {
    var hasInput = activeSource === 'pdf' ? !!pendingFile : !!pasteInput.value.trim();
    btnConvert.disabled = !hasInput;
    convertHint.textContent = hasInput ? ''
      : (activeSource === 'pdf' ? 'Choose a PDF, then Convert.' : 'Paste text, then Convert.');
  }

  function setConverting(on) {
    btnConvert.disabled = on || btnConvert.disabled;
    btnConvert.textContent = '';
    var svg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3l14 9-14 9V3z"/></svg>';
    btnConvert.innerHTML = svg + (on ? ' Converting…' : ' Convert');
    if (!on) refreshConvertState();
  }

  function selectSource(which) {
    activeSource = which === 'pdf' ? 'pdf' : 'text';
    var pdf = activeSource === 'pdf';
    // The site's .segmented component styles the active button off
    // aria-pressed; the tablist semantics this control was written with use
    // aria-selected. Both are set so the shared CSS and the assistive-tech
    // contract stay in agreement.
    tabPdf.setAttribute('aria-selected', pdf ? 'true' : 'false');
    tabText.setAttribute('aria-selected', pdf ? 'false' : 'true');
    tabPdf.setAttribute('aria-pressed', pdf ? 'true' : 'false');
    tabText.setAttribute('aria-pressed', pdf ? 'false' : 'true');
    panePdf.hidden = !pdf;
    paneText.hidden = pdf;
    // Switching source clears any staged input/results.
    pendingFile = null;
    fileInput.value = '';
    fileSlot.innerHTML = '';
    currentRows = null;
    resultPanel.hidden = true;
    btnDownload.disabled = true;
    setStatus('');
    refreshConvertState();
  }

  tabPdf.addEventListener('click', function () { selectSource('pdf'); });
  tabText.addEventListener('click', function () { selectSource('text'); });

  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault(); dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('is-dragover'); });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault(); dropzone.classList.remove('is-dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) selectFile(fileInput.files[0]);
  });
  pasteInput.addEventListener('input', refreshConvertState);

  btnConvert.addEventListener('click', runConvert);
  btnClear.addEventListener('click', clearAll);

  btnDownload.addEventListener('click', function () {
    if (!currentRows) return;
    var re = buildHighlighter();
    var blob = window.xlsxWriter.build(currentRows, re, splitRuns, { bandText: '' });
    downloadBlob(blob, currentName + '.xlsx');
  });

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---- Initial state ---- */
  pageLimitNote.textContent = 'Specifications up to ' + MAX_PAGES + ' pages.';
  refreshConvertState();
  loadRules();   // warm the highlight rules in the background
})();
