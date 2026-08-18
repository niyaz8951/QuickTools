/* Parts List Extractor — UI.
 *
 * All the work happens in extractor-worker.js. This file collects files, runs
 * the worker, draws the progress bar and hands back the workbook. Nothing is
 * parsed until Extract is pressed, and a run in flight can always be cancelled
 * — the same rule the container calculator follows.
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var dropzone = $('#dropzone');
  var fileInput = $('#file-input');
  var fileList = $('#file-list');
  var fileNote = $('#file-note');
  var runBtn = $('#run-btn');
  var runNote = $('#run-note');
  var progress = $('#progress');
  var cancelBtn = $('#cancel-btn');
  var resultPanel = $('#result-panel');
  var downloadBtn = $('#download-btn');
  var clearBtn = $('#clear-btn');
  var logBody = $('#log-body');
  var statsEl = $('#result-stats');
  var keepDash = $('#keep-dash');

  var chosen = [];        // File objects
  var worker = null;
  var startedAt = 0;
  var result = null;      // { buffer, rowCount, ... }

  /* ---------------- files ---------------- */

  function addFiles(list) {
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (!/\.(xlsx|xlsm|xls)$/i.test(f.name)) continue;
      if (/^~\$/.test(f.name)) continue;          // Excel lock files
      // Same name and size twice is the same workbook picked twice.
      var dupe = chosen.some(function (c) { return c.name === f.name && c.size === f.size; });
      if (!dupe) chosen.push(f);
    }
    renderFiles();
  }

  function renderFiles() {
    fileList.innerHTML = '';
    chosen.forEach(function (f, i) {
      var li = document.createElement('li');
      li.className = 'pe-file';
      var name = document.createElement('span');
      name.className = 'pe-file__name';
      name.textContent = f.name;
      var size = document.createElement('span');
      size.className = 'pe-file__size';
      size.textContent = (f.size / 1024 / 1024).toFixed(1) + ' MB';
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'btn btn--ghost btn--sm';
      rm.textContent = 'Remove';
      rm.addEventListener('click', function () {
        chosen.splice(i, 1);
        renderFiles();
      });
      li.append(name, size, rm);
      fileList.appendChild(li);
    });

    fileNote.textContent = chosen.length
      ? chosen.length + ' workbook' + (chosen.length === 1 ? '' : 's') + ' ready.'
      : 'No workbooks chosen yet.';
    syncRun();
  }

  function syncRun() {
    runBtn.disabled = chosen.length === 0;
    runBtn.textContent = chosen.length
      ? 'Extract ' + chosen.length + ' workbook' + (chosen.length === 1 ? '' : 's')
      : 'Extract';
    runNote.textContent = chosen.length ? '' : 'Add at least one workbook.';
  }

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
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files) addFiles(fileInput.files);
    fileInput.value = '';       // so the same file can be re-picked after removal
  });

  /* ---------------- progress ---------------- */

  function showProgress(on) {
    progress.hidden = !on;
    runBtn.hidden = on;
    if (on) setProgress(0, 'Starting…');
  }

  function setProgress(fraction, label) {
    var pct = Math.round(fraction * 100);
    $('#progress-fill').style.width = pct + '%';
    $('#progress-bar').setAttribute('aria-valuenow', String(pct));
    $('#progress-pct').textContent = pct + '%';
    if (label) {
      var secs = Math.round((Date.now() - startedAt) / 1000);
      $('#progress-text').textContent = secs > 3 ? label + ' — ' + secs + 's' : label;
    }
  }

  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; }
    showProgress(false);
    syncRun();
  }

  /* ---------------- run ---------------- */

  function run() {
    if (!chosen.length) return;
    if (worker) worker.terminate();
    startedAt = Date.now();
    result = null;
    resultPanel.hidden = true;

    try {
      worker = new Worker('extractor-worker.js');
    } catch (err) {
      worker = null;
    }
    if (!worker) {
      runNote.textContent = 'This browser cannot run the extractor (Web Workers unavailable). '
        + 'Open the site over http rather than from a file, and try a current browser.';
      return;
    }

    showProgress(true);
    setProgress(0, 'Reading workbooks');

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.fraction, msg.label);
      } else if (msg.type === 'done') {
        result = msg;
        renderResult(msg);
        stopWorker();
      } else if (msg.type === 'error') {
        stopWorker();
        runNote.textContent = 'Extraction failed: ' + msg.message;
      }
    };
    worker.onerror = function (err) {
      stopWorker();
      runNote.textContent = 'Extraction failed: ' + (err.message || 'worker error');
    };

    /* Files are read here, on the main thread, because FileReader in a worker
       adds nothing — the read itself is not what costs the seconds. Buffers
       are transferred, not copied. */
    var buffers = [];
    var pending = chosen.length;
    chosen.forEach(function (f, i) {
      var reader = new FileReader();
      reader.onload = function () {
        buffers[i] = { name: f.name, buffer: reader.result };
        if (--pending === 0) {
          worker.postMessage(
            { files: buffers, keepDash: keepDash.checked },
            buffers.map(function (b) { return b.buffer; })
          );
        }
      };
      reader.onerror = function () {
        buffers[i] = { name: f.name, buffer: new ArrayBuffer(0) };
        if (--pending === 0) {
          worker.postMessage({ files: buffers, keepDash: keepDash.checked });
        }
      };
      reader.readAsArrayBuffer(f);
    });
  }

  /* ---------------- result ---------------- */

  function stat(label, value) {
    var d = document.createElement('div');
    d.className = 'stat';
    var v = document.createElement('span');
    v.className = 'stat__value';
    v.textContent = value;
    var l = document.createElement('span');
    l.className = 'stat__label';
    l.textContent = label;
    d.append(v, l);
    return d;
  }

  function renderResult(msg) {
    var sheetsOk = msg.log.filter(function (r) { return r.Rows > 0; }).length;
    var problems = msg.log.filter(function (r) {
      return /ERROR|OPEN FAILED/.test(r.Status);
    }).length;

    statsEl.innerHTML = '';
    statsEl.append(
      stat('rows extracted', msg.rowCount.toLocaleString()),
      stat('sheets with data', String(sheetsOk)),
      stat('sheets scanned', String(msg.log.length)),
      stat('seconds', (msg.ms / 1000).toFixed(1))
    );
    if (msg.flagCount) statsEl.append(stat('headers to check', String(msg.flagCount)));
    if (problems) statsEl.append(stat('failures', String(problems)));

    logBody.innerHTML = '';
    msg.log.forEach(function (r) {
      var tr = document.createElement('tr');
      if (/ERROR|OPEN FAILED/.test(r.Status)) tr.className = 'is-bad';
      else if (r.Rows === 0 && r.Status === 'no parts table found') tr.className = 'is-warn';
      [r['Source File'], r.Sheet, r.Rows ? String(r.Rows) : '', r.Status].forEach(function (v) {
        var td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      logBody.appendChild(tr);
    });

    resultPanel.hidden = false;
    downloadBtn.disabled = msg.rowCount === 0;
    runNote.textContent = msg.rowCount
      ? ''
      : 'No parts tables were recognised. Check the log below.';
  }

  downloadBtn.addEventListener('click', function () {
    if (!result) return;
    var blob = new Blob([result.buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Parts_Database.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  clearBtn.addEventListener('click', function () {
    chosen = [];
    result = null;
    resultPanel.hidden = true;
    logBody.innerHTML = '';
    renderFiles();
  });

  runBtn.addEventListener('click', run);
  cancelBtn.addEventListener('click', function () {
    stopWorker();
    runNote.textContent = 'Extraction cancelled.';
  });

  syncRun();
})();
