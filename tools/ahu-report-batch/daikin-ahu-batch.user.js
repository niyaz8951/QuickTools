// ==UserScript==
// @name         Thinkneering — Daikin AHU Batch Report Export
// @namespace    https://thinkneering.com/
// @version      2.0.0
// @description  Work through a Daikin project's unit list, saving every unit report as RTF.
// @author       Thinkneering
// @match        https://tools.daikinapplied.eu/ManageProjects/*
// @match        https://*.daikinapplied.eu/Report/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Runs inside the Daikin pages, reusing the session already logged in. It reads
 * no credentials and sends nothing anywhere — every request it causes is one
 * the portal would have made had you clicked through by hand.
 *
 * WHY THIS SCRIPT RUNS IN THREE PLACES
 *
 * The project list is served from tools.daikinapplied.eu, but both dialogs load
 * their contents from tools4.daikinapplied.eu:
 *
 *   #Select-dialog  →  /Report/SelectReportAHU.aspx
 *   #form-dialog    →  /Report/ReportAHU.aspx
 *
 * Different host, different origin. A userscript on the parent page cannot read
 * or click anything inside those iframes — contentDocument is simply null. That
 * is a browser guarantee, not a gap to work around. (Selenium had no trouble
 * here because switch_to.frame drives the browser above the same-origin policy.
 * A script running inside a page does not get that.)
 *
 * So the script loads into all three documents and they talk over postMessage:
 *
 *   controller  (ManageProjects)      panel, grid, report button, dialog close
 *   select      (SelectReportAHU)     ticks the report sections
 *   report      (ReportAHU)           sets RTF, presses save
 *
 * The jQuery UI button bars — "Show Report" and "Close" — belong to the parent
 * document, not the iframes, so the controller still presses those itself.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  // Element ids taken from the live portal. The most likely thing to break
  // after a vendor update, so they live in one place.
  const SEL = {
    // Master-detail grid: MainContent_GridProject holds projects, and each
    // project's detail row contains the GridUnit units grid. Nothing with a
    // GridUnit id exists until the project row is expanded.
    projectGrid: 'MainContent_GridProject',
    detailCollapsed: 'img.dxGridView_gvDetailCollapsedButton_Metropolis',
    detailExpanded: 'img.dxGridView_gvDetailExpandedButton_Metropolis',

    unitSelectButton: (i) => `GridUnit_DXSelBtn${i}_D`,
    unitReportButton: (i) => `GridUnit_DXCBtn${6 * i + 1}Img`,

    // Parent document — jQuery UI renders dialog buttons outside the iframe.
    generateButton: '#ButtonRep',
    dialogCloseBar: 'div.ui-dialog-buttonpane.ui-widget-content.ui-helper-clearfix',

    // Inside SelectReportAHU.aspx.
    optFanCurve: '#ASPxFormLayout1_ChkFanCurve_S_D',
    optListPrice: '#ASPxFormLayout1_ChkListPrice_S_D',

    // Inside ReportAHU.aspx.
    reportCanvas: '#document_AHU_Splitter_1i0_CC',
    formatCombo: '#document_AHU_Splitter_Toolbar_Menu_ITCNT11_SaveFormat_I',
    saveButton: '#document_AHU_Splitter_Toolbar_Menu_DXI9_T',
  };

  const TIMEOUT = {
    element: 30000,
    frame: 45000, // report generation is server-side and can be slow
    settle: 400,
    download: 2500, // breathing room for the browser to start saving
  };

  // The loop ends when the grid runs out of rows. This only guards a runaway.
  const MAX_UNITS = 2000;

  const ORIGIN_OK = /^https:\/\/[a-z0-9-]+\.daikinapplied\.eu$/i;

  /* ----------------------------------------------------------------- utils */

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

  /* ---------------------------------------------------------------- clicks */

  /* DevExpress binds to mousedown/mouseup, not to the synthetic event
     `.click()` fires, and the node carrying the id is often a decorative inner
     span with no handler of its own. So a click is attempted four ways, in
     order of how faithfully each imitates a real mouse. */

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function mouseSequence(el) {
    const win = el.ownerDocument.defaultView;
    const rect = el.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: win,
      button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };

    const steps = [
      ['pointerover', 'PointerEvent'],
      ['mouseover', 'MouseEvent'],
      ['pointerdown', 'PointerEvent'],
      ['mousedown', 'MouseEvent'],
      ['pointerup', 'PointerEvent'],
      ['mouseup', 'MouseEvent'],
      ['click', 'MouseEvent'],
    ];

    for (const [type, ctorName] of steps) {
      const Ctor = win[ctorName] || win.MouseEvent;
      try {
        el.dispatchEvent(new Ctor(type, options));
      } catch (err) {
        /* older frames may not expose PointerEvent; the mouse pair covers it */
      }
    }
  }

  // Walks up from a decorative span to whatever actually carries the handler.
  function handlerTarget(el) {
    let node = el;
    for (let depth = 0; node && depth < 4; depth++) {
      if (node.onclick || node.onmousedown || node.getAttribute?.('onclick')) return node;
      if (node.tagName === 'A' || node.tagName === 'BUTTON') return node;
      node = node.parentElement;
    }
    return el.parentElement || el;
  }

  function clickStrategies(el) {
    return [
      { name: 'mouse sequence', run: () => mouseSequence(el) },
      { name: 'ancestor mouse sequence', run: () => mouseSequence(handlerTarget(el)) },
      { name: 'native click', run: () => el.click() },
      {
        name: 'inline onclick',
        run: () => {
          const target = handlerTarget(el);
          if (target.onclick) target.onclick.call(target);
          else throw new Error('no onclick to invoke');
        },
      },
    ];
  }

  async function press(el, label) {
    if (!el) throw new Error(`${label}: element not present`);

    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    await sleep(150);

    let lastError = null;
    for (const strategy of clickStrategies(el)) {
      try {
        strategy.run();
        return true;
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(`${label}: click had no effect${lastError ? ` (${lastError.message})` : ''}`);
  }

  /* Escalates through the strategies, checking after each whether the page
     actually changed.

     maxStrategies exists because escalation is dangerous on anything that
     toggles: strategy 2 undoes strategy 1, and the control ends up wherever the
     last attempt left it. Callers driving a toggle cap this low. Anything that
     toggles on every click, like a checkbox, must not use this at all — see
     tickBox. */
  async function pressUntil(el, done, label, { settleMs = 4000, maxStrategies = 4 } = {}) {
    if (!el) throw new Error(`${label}: element not present`);
    if (done()) return true;

    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    await sleep(150);

    const tried = [];
    for (const strategy of clickStrategies(el).slice(0, maxStrategies)) {
      try {
        strategy.run();
      } catch (err) {
        tried.push(`${strategy.name} (threw)`);
        continue;
      }
      tried.push(strategy.name);

      // DevExpress answers over a callback, so the change is not immediate.
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        await sleep(200);
        if (done()) return true;
      }
    }

    throw new Error(`${label}: no click had any effect — tried ${tried.join(', ')}`);
  }

  // ASPxGridView rebinds rows during scroll, which detaches the node we hold,
  // so the id is re-resolved on every attempt rather than cached.
  async function pressById(doc, id, label, attempts = 30) {
    let lastError = null;
    for (let n = 0; n < attempts; n++) {
      const el = doc.getElementById(id);
      if (el && isVisible(el)) {
        try {
          return await press(el, label);
        } catch (err) {
          lastError = err;
        }
      }
      await sleep(250);
    }
    throw new Error(lastError ? lastError.message : `${label}: #${id} never became clickable`);
  }

  /* -------------------------------------------------------------- checkbox */

  /* Reading a DevExpress checkbox.

     The display span's class is the reliable signal, because it is what the
     page actually renders. The inner input's value is a fallback only: on the
     grid's selection checkbox it can sit at "U" even once the row is ticked,
     and reading it first made an earlier version believe every tick had failed.

     "Unchecked" is tested before "Checked" — the two class names differ by one
     letter and testing in the wrong order misreads the state.

     Returns true, false, or null where neither signal is conclusive. Null means
     "cannot tell", which is not the same as "not ticked". */
  function boxState(el) {
    if (!el) return null;
    if (/CheckBoxUnchecked/i.test(el.className)) return false;
    if (/CheckBoxChecked/i.test(el.className)) return true;

    const input = el.querySelector('input');
    const value = input && input.value ? input.value.toUpperCase() : '';
    if (value === 'C') return true;
    if (value === 'U') return false;
    return null;
  }

  /* Ticking gets exactly one attempt, on the checkbox itself.

     A checkbox toggles on every click, so escalate-and-recheck is actively
     wrong here: each strategy undoes the one before it, leaving boxes flickering
     on and off. It does not fall back to an ancestor either — the row under a
     grid checkbox carries its own selection handler, so a stray dispatch there
     can tick a different row than the one asked for. */
  async function tickBox(el) {
    const before = boxState(el);
    if (before === true) return 'already ticked';
    if (!el) return 'no checkbox found';

    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    await sleep(150);

    try {
      mouseSequence(el);
    } catch (err) {
      return `tick attempt failed (${err.message})`;
    }

    await sleep(TIMEOUT.settle);
    const after = boxState(el);
    if (after === true) return 'ticked';
    if (after === null) return 'tick state unknown';
    return 'tick did not register';
  }

  /* ================================================================ agents */

  /* The two dialog documents. Each announces itself to the parent until it is
     given a command, which removes any dependence on load ordering, then does
     its one job and reports back. */

  function announce(page, isDone) {
    const beat = () => {
      if (isDone()) return;
      try {
        window.parent.postMessage({ tnahu: true, type: 'ready', page }, '*');
      } catch (err) {
        /* parent may not be reachable yet */
      }
      setTimeout(beat, 400);
    };
    beat();
  }

  function commandListener(type, handler) {
    let handled = false;
    window.addEventListener('message', async (event) => {
      if (handled) return;
      if (!ORIGIN_OK.test(event.origin)) return;
      const message = event.data;
      if (!message || message.tnahu !== true || message.type !== type) return;

      handled = true;
      const reply = (payload) => {
        try {
          window.parent.postMessage({ tnahu: true, ...payload }, event.origin);
        } catch (err) {
          /* nothing useful to do if the parent has gone */
        }
      };

      try {
        reply(await handler(message));
      } catch (err) {
        reply({ type: 'failed', message: err.message });
      }
    });
    return () => handled;
  }

  // SelectReportAHU.aspx — tick the requested report sections.
  function runSelectAgent() {
    const isDone = commandListener('do-select', async (message) => {
      const notes = [];

      if (message.fanCurve) {
        const el = await waitFor(SEL.optFanCurve);
        notes.push(`fan curve ${await tickBox(el)}`);
        await sleep(TIMEOUT.settle);
      }
      if (message.listPrice) {
        const el = await waitFor(SEL.optListPrice);
        notes.push(`list price ${await tickBox(el)}`);
        await sleep(TIMEOUT.settle);
      }

      return { type: 'select-done', notes };
    });

    announce('select', isDone);
  }

  // ReportAHU.aspx — switch the export format to RTF, then save.
  function runReportAgent() {
    const isDone = commandListener('do-save', async () => {
      await waitFor(SEL.reportCanvas, { timeout: TIMEOUT.frame });

      const combo = document.querySelector(SEL.formatCombo);
      if (combo) {
        combo.value = 'RTF';
        // The DevExpress combo keeps its real value in a sibling hidden input.
        const hidden = document.getElementById(`${combo.id.slice(0, -2)}_VI`);
        if (hidden) hidden.value = 'RTF';
        combo.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(TIMEOUT.settle);
      }

      const save = await waitFor(SEL.saveButton, { timeout: TIMEOUT.frame });
      await press(save, 'Save button');
      await sleep(TIMEOUT.download);

      return { type: 'save-done', format: combo ? combo.value : 'unchanged' };
    });

    announce('report', isDone);
  }

  /* ============================================================ controller */

  /* Talks to the two dialog frames. Frames announce themselves repeatedly, so
     a waiter registered late still catches the next beat. */
  const Bridge = {
    waiters: [],

    init() {
      window.addEventListener('message', (event) => {
        if (!ORIGIN_OK.test(event.origin)) return;
        const message = event.data;
        if (!message || message.tnahu !== true) return;

        for (let i = 0; i < this.waiters.length; i++) {
          const waiter = this.waiters[i];
          if (!waiter.matches(message)) continue;
          this.waiters.splice(i, 1);
          clearTimeout(waiter.timer);
          waiter.resolve({ message, source: event.source, origin: event.origin });
          return;
        }
      });
    },

    expect(type, page, timeout = TIMEOUT.frame) {
      return new Promise((resolve, reject) => {
        const waiter = {
          matches: (m) =>
            (m.type === type && (!page || m.page === page)) || m.type === 'failed',
          resolve: (hit) =>
            hit.message.type === 'failed'
              ? reject(new Error(`${page || type} frame: ${hit.message.message}`))
              : resolve(hit),
        };
        waiter.timer = setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`Timed out waiting for the ${page || type} dialog`));
        }, timeout);
        this.waiters.push(waiter);
      });
    },

    reset() {
      for (const waiter of this.waiters) clearTimeout(waiter.timer);
      this.waiters = [];
    },
  };

  function isProjectExpanded(doc) {
    return !!doc.querySelector(SEL.detailExpanded);
  }

  async function ensureProjectExpanded(doc) {
    if (isProjectExpanded(doc)) return 'already open';

    const toggle = doc.querySelector(SEL.detailCollapsed);
    if (!toggle) {
      throw new Error('No project row found to expand — open a project list before starting');
    }

    // Two strategies only: the arrow toggles, so a third attempt would collapse
    // the row it just opened.
    await pressUntil(toggle, () => isProjectExpanded(doc), 'Project expand arrow', {
      maxStrategies: 2,
    });

    // The units grid arrives with the detail row, over a separate callback.
    await waitFor(`#${SEL.unitSelectButton(0)}`, { root: doc });
    return 'expanded';
  }

  const Runner = {
    cancelled: false,

    async exportUnit(index, options) {
      const doc = document;
      const reportId = SEL.unitReportButton(index);

      // An absent report button means the grid has run out of rows.
      if (!doc.getElementById(reportId)) return { done: true };

      // Scroll the row in and tick it. The working Python script only ever
      // scrolled here — its checkbox click was commented out — and the report
      // opened from the report button regardless. So the tick is best-effort
      // and its outcome never blocks the export.
      const tick = await tickBox(doc.getElementById(SEL.unitSelectButton(index)));
      if (tick !== 'already ticked') UI.log(`  ${tick}`, tick === 'ticked' ? 'muted' : 'warning');

      Bridge.reset();
      await pressById(doc, reportId, `Unit ${index + 1} report button`);

      // 1. Select dialog. Cross-origin, so its own agent does the ticking.
      const select = await Bridge.expect('ready', 'select');
      select.source.postMessage(
        {
          tnahu: true,
          type: 'do-select',
          fanCurve: options.fanCurve,
          listPrice: options.listPrice,
        },
        select.origin
      );
      const selected = await Bridge.expect('select-done');
      for (const note of selected.message.notes || []) UI.log(`  ${note}`, 'muted');

      // 2. "Show Report" belongs to the parent document, not the iframe.
      const generate = await waitFor(SEL.generateButton);
      await press(generate, 'Show Report button');

      // 3. Report dialog. Also cross-origin; its agent sets RTF and saves.
      const report = await Bridge.expect('ready', 'report');
      report.source.postMessage({ tnahu: true, type: 'do-save' }, report.origin);
      await Bridge.expect('save-done');

      // 4. Close the viewer so the grid is interactive for the next unit.
      const closeBar = document.querySelector(SEL.dialogCloseBar);
      if (closeBar) {
        const button = closeBar.querySelector('button');
        if (button) await press(button, 'Dialog close button');
      }
      await sleep(TIMEOUT.settle);

      return { done: false };
    },

    async run(options) {
      this.cancelled = false;
      let saved = 0;
      let missed = 0;

      // Without this the units grid does not exist yet and every lookup fails.
      try {
        const state = await ensureProjectExpanded(document);
        UI.log(`Project ${state}.`, 'muted');
      } catch (err) {
        UI.log(err.message, 'danger');
        return;
      }

      UI.log(`Starting at unit ${options.start}, running to the end of the list.`, 'muted');

      for (let index = options.start - 1; index < MAX_UNITS; index++) {
        if (this.cancelled) {
          UI.log('Stopped.', 'warning');
          break;
        }

        const label = `Unit ${index + 1}`;
        UI.log(`${label} — exporting…`);

        let result;
        try {
          result = await this.exportUnit(index, options);
        } catch (err) {
          missed++;
          UI.log(`${label} — ${err.message}`, 'danger');
          UI.count(saved, missed);

          // Leave no dialog open, or the next unit cannot reach the grid.
          const closeBar = document.querySelector(SEL.dialogCloseBar);
          const button = closeBar && closeBar.querySelector('button');
          if (button) {
            try {
              await press(button, 'Dialog close button');
              await sleep(TIMEOUT.settle);
            } catch (closeErr) {
              /* nothing more to try; the next unit will report its own failure */
            }
          }
          continue;
        }

        if (result.done) {
          UI.log('End of the unit list.', 'muted');
          break;
        }

        saved++;
        UI.log(`${label} — saved`, 'success');
        UI.count(saved, missed);
      }

      Bridge.reset();
      UI.log(
        `Finished — ${saved} report${saved === 1 ? '' : 's'} saved` +
          (missed ? `, ${missed} failed` : '') + '.',
        missed ? 'warning' : 'success'
      );
    },
  };

  /* -------------------------------------------------------------------- ui */

  // Shadow DOM keeps the portal's stylesheet out of the panel and the panel's
  // rules out of the portal.
  const UI = {
    logEl: null,
    countEl: null,

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
        width: 300px;
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
      h2 { font-family: var(--font-heading); font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
      .icon { width: 18px; height: 18px; flex: none; color: var(--color-primary); }
      .body { padding: var(--space-3); display: grid; gap: var(--space-3); }
      .field { display: grid; gap: var(--space-1); }
      label { font-size: 12px; color: var(--color-text-muted); }
      input[type='number'] {
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
      button.primary:hover:not(:disabled) {
        background: var(--color-primary-dark);
        border-color: var(--color-primary-dark);
      }
      button:disabled { opacity: 0.5; cursor: not-allowed; }
      :focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
      .count { font-family: var(--font-mono); font-size: 12px; color: var(--color-text-muted); margin: 0; }
      .log {
        font-family: var(--font-mono);
        font-size: 12px;
        line-height: 1.6;
        max-height: 240px;
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
          <div class="field">
            <label for="start">Start from unit</label>
            <input type="number" id="start" min="1" value="1">
          </div>
          <div class="check">
            <input type="checkbox" id="fan" checked>
            <label for="fan">Include fan curve</label>
          </div>
          <div class="check">
            <input type="checkbox" id="price" checked>
            <label for="price">Include list price</label>
          </div>
          <p class="count" id="count">Not started</p>
          <div class="actions">
            <button type="button" class="primary" id="start-run">Start export</button>
            <button type="button" id="stop" disabled>Stop</button>
          </div>
        </div>
        <div class="log" id="log" role="status" aria-live="polite"></div>
      `;
      shadow.appendChild(panel);

      this.logEl = shadow.getElementById('log');
      this.countEl = shadow.getElementById('count');

      const startBtn = shadow.getElementById('start-run');
      const stopBtn = shadow.getElementById('stop');

      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        this.logEl.textContent = '';
        this.count(0, 0);

        await Runner.run({
          start: Math.max(1, Number(shadow.getElementById('start').value) || 1),
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

      shadow.getElementById('hide').addEventListener('click', () => {
        panel.style.display = 'none';
      });

      this.log('Open a project list, pick a starting unit, then start.', 'muted');
    },

    log(message, tone) {
      if (!this.logEl) return;
      const line = document.createElement('p');
      if (tone) line.className = tone;
      line.textContent = message;
      this.logEl.appendChild(line);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    },

    count(saved, missed) {
      if (!this.countEl) return;
      this.countEl.textContent = `${saved} saved` + (missed ? `, ${missed} failed` : '');
    },
  };

  function runController() {
    Bridge.init();

    /* Exposed for console debugging when a step stalls. From the project page:
         TNAHU.expand()      - expand the first project row
         TNAHU.state(0)      - unit 1 tick state (true / false / null)
         TNAHU.tick(0)       - tick it, once, and report the outcome
         TNAHU.try('SomeId') - report what is found, then try to click it
         TNAHU.selectors     - the ids the run depends on

       Note that the dialog frames are a different origin, so nothing here can
       reach inside them. To debug those, open the frame in its own tab. */
    window.TNAHU = {
      selectors: SEL,
      press,
      expand: () => ensureProjectExpanded(document),
      state: (i) => boxState(document.getElementById(SEL.unitSelectButton(i))),
      tick: (i) => tickBox(document.getElementById(SEL.unitSelectButton(i))),
      async try(id) {
        const target = document.getElementById(id);
        if (!target) {
          console.log(`#${id} not found in this document.`);
          return false;
        }
        console.log(`#${id}`, {
          tag: target.tagName,
          className: target.className,
          visible: isVisible(target),
          rect: target.getBoundingClientRect(),
          handlerTarget: handlerTarget(target),
        });
        try {
          await press(target, id);
          console.log('click dispatched — check whether the page reacted');
          return true;
        } catch (err) {
          console.log('click failed:', err.message);
          return false;
        }
      },
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => UI.mount());
    } else {
      UI.mount();
    }
  }

  /* ------------------------------------------------------------- dispatch */

  // "SelectReportAHU.aspx" contains "ReportAHU.aspx", so it must be tested
  // first or the select dialog would run the report agent.
  const path = location.pathname;
  if (/SelectReportAHU\.aspx/i.test(path)) {
    runSelectAgent();
  } else if (/ReportAHU\.aspx/i.test(path)) {
    runReportAgent();
  } else if (/\/ManageProjects\//i.test(path)) {
    runController();
  }
})();
