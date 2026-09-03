// ==UserScript==
// @name         Thinkneering — Daikin AHU Batch Report Export
// @namespace    https://thinkneering.com/
// @version      0.1.0
// @description  Batch-export AHU unit reports as RTF from the Daikin Applied project tool, with optional zip packaging.
// @author       Thinkneering
// @match        https://tools.daikinapplied.eu/ManageProjects/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Runs inside the Daikin page, so every request is same-origin and reuses the
 * session the user already logged into. No credentials are read, stored or sent
 * anywhere by this script.
 *
 * Two delivery modes:
 *   "zip"  - intercept each generated RTF, hold it in memory, emit one archive.
 *   "each" - do not intercept; let the browser download each file natively.
 *
 * Zip mode depends on how the DevExpress viewer emits the file. If interception
 * comes up empty, the run reports it and you can fall back to "each". The
 * Diagnose button records what the Save button actually does so the selectors
 * below can be corrected without guesswork.
 */

(function () {
  'use strict';

  // Element IDs are taken from the live portal. They are the most likely thing
  // to break after a vendor update, so they live in one place.
  const SEL = {
    unitSelectButton: (i) => `GridUnit_DXSelBtn${i}_D`,
    unitReportButton: (i) => `GridUnit_DXCBtn${6 * i + 1}Img`,
    optionsDialog: '#Select-dialog',
    optFanCurve: '#ASPxFormLayout1_ChkFanCurve_S_D',
    optListPrice: '#ASPxFormLayout1_ChkListPrice_S_D',
    generateButton: '#ButtonRep',
    reportDialog: '#form-dialog',
    reportCanvas: '#document_AHU_Splitter_1i0_CC',
    formatCombo: '#document_AHU_Splitter_Toolbar_Menu_ITCNT11_SaveFormat_I',
    saveButton: '#document_AHU_Splitter_Toolbar_Menu_DXI9_T',
    dialogCloseBar: 'div.ui-dialog-buttonpane.ui-widget-content.ui-helper-clearfix',
  };

  const TIMEOUT = {
    element: 30000,
    download: 45000,
    settle: 400,
  };

  /* ---------------------------------------------------------------- utils */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(selector, { root = document, timeout = TIMEOUT.element } = {}) {
    return new Promise((resolve, reject) => {
      const find = () => root.querySelector(selector);
      const first = find();
      if (first) return resolve(first);

      const target = root.documentElement || root.body || root;
      const observer = new MutationObserver(() => {
        const el = find();
        if (!el) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      });
      observer.observe(target, { childList: true, subtree: true, attributes: true });

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for ${selector}`));
      }, timeout);
    });
  }

  // Dialog iframes are created before their document is parsed, so waiting for
  // the iframe element alone is not enough.
  async function frameDocument(iframe, timeout = TIMEOUT.element) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const doc = iframe.contentDocument;
      if (doc && doc.body && doc.readyState !== 'loading') return doc;
      await sleep(100);
    }
    throw new Error('Dialog frame never finished loading');
  }

  // ASPxGridView rebinds rows during scroll, which detaches the node we are
  // holding. Re-resolving by id on each attempt survives that.
  async function clickById(doc, id, attempts = 40) {
    for (let n = 0; n < attempts; n++) {
      const el = doc.getElementById(id);
      if (el) {
        try {
          el.click();
          return true;
        } catch (err) {
          /* node went stale mid-click; fall through and retry */
        }
      }
      await sleep(250);
    }
    throw new Error(`Could not click #${id}`);
  }

  async function clickEl(el, attempts = 20) {
    for (let n = 0; n < attempts; n++) {
      try {
        el.click();
        return true;
      } catch (err) {
        await sleep(200);
      }
    }
    throw new Error('Element refused to accept a click');
  }

  /* ------------------------------------------------------------------ zip */

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Native DEFLATE keeps the archive small without pulling in a zip library.
  // Falls back to stored entries where CompressionStream is unavailable.
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      return out.length < bytes.length ? out : null;
    } catch (err) {
      return null;
    }
  }

  function dosDateTime(date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  async function buildZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    const stamp = dosDateTime(new Date());
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const raw = new Uint8Array(await file.blob.arrayBuffer());
      const crc = crc32(raw);
      const packed = await deflateRaw(raw);
      const data = packed || raw;
      const method = packed ? 8 : 0;

      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 0x04034b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 0x0800, true); // UTF-8 filename flag
      header.setUint16(8, method, true);
      header.setUint16(10, stamp.time, true);
      header.setUint16(12, stamp.day, true);
      header.setUint32(14, crc, true);
      header.setUint32(18, data.length, true);
      header.setUint32(22, raw.length, true);
      header.setUint16(26, nameBytes.length, true);
      header.setUint16(28, 0, true);

      chunks.push(new Uint8Array(header.buffer), nameBytes, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, method, true);
      entry.setUint16(12, stamp.time, true);
      entry.setUint16(14, stamp.day, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, raw.length, true);
      entry.setUint16(28, nameBytes.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: 'application/zip',
    });
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* -------------------------------------------------------------- capture */

  // The report is produced server-side and handed to the browser as a download.
  // To collect it in memory instead, every plausible delivery route is wrapped:
  // fetch, XHR, form submit, window.open and download anchors.
  const Capture = {
    armed: false,
    diagnostic: false,
    hits: [],
    trace: [],
    patched: new WeakSet(),
    originalSubmit: new WeakMap(),

    attach(win) {
      if (!win || this.patched.has(win)) return;
      try {
        void win.document;
      } catch (err) {
        return; // cross-origin frame, nothing we can do
      }
      this.patched.add(win);
      const self = this;

      if (win.fetch) {
        const originalFetch = win.fetch;
        win.fetch = function (...args) {
          const url = args[0] && args[0].url ? args[0].url : String(args[0]);
          return originalFetch.apply(this, args).then((res) => {
            if (self.armed) self.inspect(res.clone(), url);
            return res;
          });
        };
      }

      const FormProto = win.HTMLFormElement && win.HTMLFormElement.prototype;
      if (FormProto && !this.originalSubmit.has(win)) {
        const originalSubmit = FormProto.submit;
        this.originalSubmit.set(win, originalSubmit);
        FormProto.submit = function () {
          if (self.armed && self.replaySubmit(win, this)) return undefined;
          return originalSubmit.call(this);
        };
      }

      const originalOpen = win.open;
      win.open = function (url, ...rest) {
        if (self.armed && url) {
          self.note(`window.open → ${url}`);
          self.fetchUrl(win, String(url));
          return null;
        }
        return originalOpen.call(this, url, ...rest);
      };

      win.document.addEventListener(
        'click',
        (event) => {
          const anchor = event.target && event.target.closest && event.target.closest('a[href]');
          if (!anchor || !self.armed) return;
          if (!anchor.hasAttribute('download') && !/export|save|rtf/i.test(anchor.href)) return;
          self.note(`anchor click → ${anchor.href}`);
          if (self.diagnostic) return;
          event.preventDefault();
          self.fetchUrl(win, anchor.href);
        },
        true
      );
    },

    note(message) {
      this.trace.push(message);
      if (this.diagnostic) UI.log(`· ${message}`, 'muted');
    },

    replaySubmit(win, form) {
      try {
        const method = (form.method || 'GET').toUpperCase();
        const action = form.action || win.location.href;
        this.note(`form.submit → ${method} ${action}`);
        if (this.diagnostic) return false;

        const params = new URLSearchParams();
        for (const [key, value] of new win.FormData(form).entries()) {
          if (typeof value === 'string') params.append(key, value);
        }

        const request =
          method === 'POST'
            ? win.fetch(action, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
              })
            : win.fetch(`${action}?${params.toString()}`, { credentials: 'include' });

        request
          .then((res) => this.inspect(res, action, { win, form }))
          .catch(() => this.resubmit(win, form));
        return true;
      } catch (err) {
        return false;
      }
    },

    resubmit(win, form) {
      const original = this.originalSubmit.get(win);
      if (original) original.call(form);
    },

    fetchUrl(win, url) {
      win
        .fetch(url, { credentials: 'include' })
        .then((res) => this.inspect(res, url))
        .catch((err) => this.note(`fetch failed: ${err.message}`));
    },

    async inspect(res, url, fallback) {
      try {
        const disposition = res.headers.get('content-disposition') || '';
        const type = res.headers.get('content-type') || '';
        const isFile =
          /attachment/i.test(disposition) ||
          /rtf|msword|octet-stream|application\/zip/i.test(type);

        this.note(`response ${res.status} ${type || 'no content-type'} ${isFile ? '(file)' : ''}`);

        if (!isFile) {
          if (fallback) this.resubmit(fallback.win, fallback.form);
          return;
        }

        const blob = await res.blob();
        if (!blob.size) return;

        const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
        const name = match ? decodeURIComponent(match[1].trim()) : '';
        this.hits.push({ name, blob, url });
      } catch (err) {
        this.note(`inspect failed: ${err.message}`);
      }
    },

    arm() {
      this.armed = true;
      this.hits = [];
    },

    disarm() {
      this.armed = false;
    },

    async collect(timeout = TIMEOUT.download) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (this.hits.length) return this.hits.shift();
        await sleep(200);
      }
      return null;
    },
  };

  Capture.attach(window);

  /* ---------------------------------------------------------------- runner */

  const Runner = {
    cancelled: false,

    async exportUnit(index, options) {
      const doc = document;
      const selectId = SEL.unitSelectButton(index);
      const reportId = SEL.unitReportButton(index);

      const reportButton = doc.getElementById(reportId);
      if (!reportButton) return { done: true };

      const selectButton = doc.getElementById(selectId);
      if (selectButton) {
        selectButton.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await sleep(TIMEOUT.settle);
      }

      await clickById(doc, reportId);

      // 1. Options dialog — pick which sections the report includes.
      const optionsFrame = await waitFor(`${SEL.optionsDialog} iframe`);
      const optionsDoc = await frameDocument(optionsFrame);

      if (options.fanCurve) {
        const fanCurve = await waitFor(SEL.optFanCurve, { root: optionsDoc });
        await clickEl(fanCurve);
        await sleep(TIMEOUT.settle);
      }
      if (options.listPrice) {
        const listPrice = await waitFor(SEL.optListPrice, { root: optionsDoc });
        await clickEl(listPrice);
        await sleep(TIMEOUT.settle);
      }

      const generate = await waitFor(SEL.generateButton);
      await clickEl(generate);

      // 2. Report viewer — switch the export format before saving.
      const reportFrame = await waitFor(`${SEL.reportDialog} iframe`);
      const reportDoc = await frameDocument(reportFrame);
      Capture.attach(reportFrame.contentWindow);

      await waitFor(SEL.reportCanvas, { root: reportDoc });

      const combo = reportDoc.querySelector(SEL.formatCombo);
      if (combo) {
        combo.value = 'RTF';
        // The DevExpress combo keeps its real value in a sibling hidden input.
        const hidden = reportDoc.getElementById(`${combo.id.slice(0, -2)}_VI`);
        if (hidden) hidden.value = 'RTF';
        combo.dispatchEvent(new reportFrame.contentWindow.Event('change', { bubbles: true }));
        await sleep(TIMEOUT.settle);
      }

      if (options.mode === 'zip') Capture.arm();

      const save = await waitFor(SEL.saveButton, { root: reportDoc });
      await clickEl(save);

      let file = null;
      if (options.mode === 'zip') {
        file = await Capture.collect();
        Capture.disarm();
      } else {
        await sleep(1500); // give the native download time to start
      }

      // 3. Close the viewer so the grid is interactive for the next unit.
      const closeBar = document.querySelector(SEL.dialogCloseBar);
      if (closeBar) {
        const button = closeBar.querySelector('button');
        if (button) await clickEl(button);
      }
      await sleep(TIMEOUT.settle);

      return { done: false, file };
    },

    async run(options) {
      this.cancelled = false;
      const collected = [];
      let missed = 0;

      for (let n = 0; n < options.count; n++) {
        if (this.cancelled) {
          UI.log('Stopped by user.', 'warning');
          break;
        }

        const index = options.start - 1 + n;
        const label = `Unit ${index + 1}`;
        UI.log(`${label} — exporting…`);

        let result;
        try {
          result = await this.exportUnit(index, options);
        } catch (err) {
          UI.log(`${label} — ${err.message}`, 'danger');
          missed++;
          continue;
        }

        if (result.done) {
          UI.log('No further units in the grid.', 'muted');
          break;
        }

        if (options.mode === 'zip') {
          if (result.file) {
            const name = result.file.name || `unit-${String(index + 1).padStart(3, '0')}.rtf`;
            collected.push({ name, blob: result.file.blob });
            UI.log(`${label} — captured ${name}`, 'success');
          } else {
            missed++;
            UI.log(`${label} — nothing captured`, 'warning');
          }
        } else {
          UI.log(`${label} — download triggered`, 'success');
        }

        UI.progress(n + 1, options.count);
      }

      Capture.disarm();

      if (options.mode === 'zip') {
        if (!collected.length) {
          UI.log(
            'No files were captured. Switch to "Download each" for this run, then use Diagnose so the export route can be pinned down.',
            'danger'
          );
          return;
        }
        UI.log(`Packaging ${collected.length} file${collected.length === 1 ? '' : 's'}…`);
        const zip = await buildZip(collected);
        const date = new Date().toISOString().slice(0, 10);
        saveBlob(zip, `ahu-reports-${date}.zip`);
        UI.log('Archive saved.', 'success');
      }

      if (missed) UI.log(`${missed} unit${missed === 1 ? '' : 's'} did not produce a file.`, 'warning');
    },
  };

  /* -------------------------------------------------------------------- ui */

  // Shadow DOM keeps the portal's stylesheet from reaching the panel and the
  // panel's rules from reaching the portal.
  const UI = {
    root: null,
    logEl: null,
    progressEl: null,

    tokens: `
      :host {
        --color-surface: #ffffff;
        --color-primary: #2f5fff;
        --color-primary-dark: #1e3fcc;
        --color-text: #14161a;
        --color-text-muted: #5c6270;
        --color-border: #e3e5ea;
        --color-success: #1fa971;
        --color-warning: #e0a100;
        --color-danger: #e0432f;
        --font-body: 'Inter', system-ui, sans-serif;
        --font-heading: 'Sora', 'Inter', system-ui, sans-serif;
        --font-mono: 'JetBrains Mono', ui-monospace, monospace;
        --space-1: 4px;
        --space-2: 8px;
        --space-3: 16px;
        --space-4: 24px;
        --radius-sm: 6px;
        --radius-md: 12px;
        --shadow-card: 0 2px 8px rgba(20, 22, 26, 0.06);
      }
    `,

    styles: `
      .panel {
        position: fixed;
        top: var(--space-3);
        right: var(--space-3);
        z-index: 2147483647;
        width: 320px;
        max-width: calc(100vw - var(--space-4));
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-card);
        font-family: var(--font-body);
        font-size: 14px;
        color: var(--color-text);
      }
      .head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3);
        border-bottom: 1px solid var(--color-border);
      }
      h2 {
        font-family: var(--font-heading);
        font-size: 15px;
        font-weight: 600;
        margin: 0;
        flex: 1;
      }
      .icon { width: 18px; height: 18px; flex: none; color: var(--color-primary); }
      .body { padding: var(--space-3); display: grid; gap: var(--space-3); }
      .row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
      .field { display: grid; gap: var(--space-1); }
      label { font-size: 12px; color: var(--color-text-muted); }
      input[type='number'], select {
        font: inherit;
        color: inherit;
        padding: var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-surface);
        width: 100%;
        box-sizing: border-box;
      }
      .check { display: flex; align-items: center; gap: var(--space-2); }
      .check label { font-size: 13px; color: var(--color-text); }
      .actions { display: flex; gap: var(--space-2); }
      button {
        font: inherit;
        font-weight: 500;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
        background: var(--color-surface);
        color: var(--color-text);
        cursor: pointer;
      }
      button.primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: #fff;
        flex: 1;
      }
      button.primary:hover:not(:disabled) { background: var(--color-primary-dark); border-color: var(--color-primary-dark); }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
      .track { height: 4px; background: var(--color-border); border-radius: var(--radius-sm); overflow: hidden; }
      .bar { height: 100%; width: 0; background: var(--color-primary); transition: width 0.2s ease; }
      .log {
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.6;
        max-height: 220px;
        overflow-y: auto;
        border-top: 1px solid var(--color-border);
        padding: var(--space-3);
        margin: 0;
        display: grid;
        gap: var(--space-1);
      }
      .log p { margin: 0; }
      .success { color: var(--color-success); }
      .warning { color: var(--color-warning); }
      .danger { color: var(--color-danger); }
      .muted { color: var(--color-text-muted); }
      @media (max-width: 420px) {
        .panel { left: var(--space-3); right: var(--space-3); width: auto; }
      }
    `,

    mount() {
      const host = document.createElement('div');
      host.id = 'tn-ahu-batch';
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = this.tokens + this.styles;
      shadow.appendChild(style);

      const panel = document.createElement('section');
      panel.className = 'panel';
      panel.innerHTML = `
        <div class="head">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>
          </svg>
          <h2>Batch report export</h2>
          <button type="button" id="hide" aria-label="Hide panel">–</button>
        </div>
        <div class="body">
          <div class="row">
            <div class="field">
              <label for="start">Start at unit</label>
              <input type="number" id="start" min="1" value="1">
            </div>
            <div class="field">
              <label for="count">How many</label>
              <input type="number" id="count" min="1" value="50">
            </div>
          </div>
          <div class="field">
            <label for="mode">Delivery</label>
            <select id="mode">
              <option value="zip">One zip at the end</option>
              <option value="each">Download each file</option>
            </select>
          </div>
          <div class="check">
            <input type="checkbox" id="fan" checked>
            <label for="fan">Include fan curve</label>
          </div>
          <div class="check">
            <input type="checkbox" id="price" checked>
            <label for="price">Include list price</label>
          </div>
          <div class="track"><div class="bar" id="bar"></div></div>
          <div class="actions">
            <button type="button" class="primary" id="start-run">Start export</button>
            <button type="button" id="stop" disabled>Stop</button>
            <button type="button" id="diagnose">Diagnose</button>
          </div>
        </div>
        <div class="log" id="log" role="status" aria-live="polite"></div>
      `;
      shadow.appendChild(panel);

      this.root = shadow;
      this.logEl = shadow.getElementById('log');
      this.progressEl = shadow.getElementById('bar');

      const startBtn = shadow.getElementById('start-run');
      const stopBtn = shadow.getElementById('stop');

      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        this.logEl.textContent = '';
        Capture.diagnostic = false;

        await Runner.run({
          start: Math.max(1, Number(shadow.getElementById('start').value) || 1),
          count: Math.max(1, Number(shadow.getElementById('count').value) || 1),
          mode: shadow.getElementById('mode').value,
          fanCurve: shadow.getElementById('fan').checked,
          listPrice: shadow.getElementById('price').checked,
        });

        startBtn.disabled = false;
        stopBtn.disabled = true;
      });

      stopBtn.addEventListener('click', () => {
        Runner.cancelled = true;
        this.log('Stopping after the current unit…', 'muted');
      });

      shadow.getElementById('diagnose').addEventListener('click', () => {
        Capture.diagnostic = true;
        Capture.armed = true;
        Capture.trace = [];
        this.logEl.textContent = '';
        this.log('Diagnostic mode on. Open one report and click Save by hand.', 'muted');
      });

      shadow.getElementById('hide').addEventListener('click', () => {
        panel.style.display = 'none';
      });

      this.log('Log in and open a project, then set a range above.', 'muted');
    },

    log(message, tone) {
      if (!this.logEl) return;
      const line = document.createElement('p');
      if (tone) line.className = tone;
      line.textContent = message;
      this.logEl.appendChild(line);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    },

    progress(done, total) {
      if (this.progressEl) this.progressEl.style.width = `${Math.round((done / total) * 100)}%`;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UI.mount());
  } else {
    UI.mount();
  }
})();
