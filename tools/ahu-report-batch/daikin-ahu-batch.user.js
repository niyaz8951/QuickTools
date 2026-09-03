// ==UserScript==
// @name         Thinkneering — Daikin AHU Batch Report Export
// @namespace    https://thinkneering.com/
// @version      1.0.0
// @description  Work through a Daikin project's unit list, saving every unit report as RTF.
// @author       Thinkneering
// @match        https://tools.daikinapplied.eu/ManageProjects/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Runs inside the Daikin page, reusing the session already logged in. It reads
 * no credentials and sends nothing anywhere — every request it causes is one
 * the portal would have made had you clicked through by hand.
 *
 * Each report is saved by the browser as it is produced. The run starts at the
 * unit you choose and carries on until the grid has no more rows.
 */

(function () {
  'use strict';

  // Element ids taken from the live portal. The most likely thing to break
  // after a vendor update, so they live in one place.
  const SEL = {
    // The page is a master-detail grid: MainContent_GridProject holds projects,
    // and each project's detail row contains the GridUnit units grid. Nothing
    // with a GridUnit id exists until the project row is expanded.
    projectGrid: 'MainContent_GridProject',
    detailCollapsed: 'img.dxGridView_gvDetailCollapsedButton_Metropolis',
    detailExpanded: 'img.dxGridView_gvDetailExpandedButton_Metropolis',

    // Selection checkbox. The id sits on the outer display span; the inner
    // input carries the state as "C" or "U", and the span's class switches
    // between ...CheckBoxChecked... and ...CheckBoxUnchecked....
    unitSelectButton: (i) => `GridUnit_DXSelBtn${i}_D`,
    unitSelectInput: (i) => `GridUnit_DXSelBtn${i}`,

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
    settle: 400,
    download: 2000, // breathing room for the browser to start saving
  };

  // The loop ends when the grid runs out of rows. This only stops a runaway if
  // something upstream goes wrong.
  const MAX_UNITS = 2000;

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

  // Dialog iframes exist before their document is parsed, so waiting for the
  // iframe element alone is not enough.
  async function frameDocument(iframe, timeout = TIMEOUT.element) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const doc = iframe.contentDocument;
      if (doc && doc.body && doc.readyState !== 'loading') return doc;
      await sleep(100);
    }
    throw new Error('Dialog frame never finished loading');
  }

  /* --------------------------------------------------------------- clicks */

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

  /* Where the result of a click is observable — a checkbox flipping, a detail
     row opening — clicking blindly is not good enough. This escalates through
     the strategies and checks after each whether the page actually changed, so
     a strategy that throws nothing but does nothing is still caught. */
  async function pressUntil(el, done, label, settleMs = 4000) {
    if (!el) throw new Error(`${label}: element not present`);
    if (done()) return true;

    el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    await sleep(150);

    const tried = [];
    for (const strategy of clickStrategies(el)) {
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

  /* ------------------------------------------------------------ grid state */

  // The detail row is what creates the GridUnit table. Until a project is
  // expanded, every GridUnit id the run depends on is simply absent — which is
  // what "cannot find the element" looks like from the outside.
  function isProjectExpanded(doc) {
    return !!doc.querySelector(SEL.detailExpanded);
  }

  async function ensureProjectExpanded(doc) {
    if (isProjectExpanded(doc)) return 'already open';

    const toggle = doc.querySelector(SEL.detailCollapsed);
    if (!toggle) {
      throw new Error('No project row found to expand — open a project list before starting');
    }

    await pressUntil(toggle, () => isProjectExpanded(doc), 'Project expand arrow');

    // The units grid arrives with the detail row, over a separate callback.
    await waitFor(`#${SEL.unitSelectButton(0)}`, { root: doc });
    return 'expanded';
  }

  // The inner input holds "C" or "U"; the display span mirrors it in its class
  // name. Checking both means a markup change to one does not blind the check.
  function isRowSelected(doc, index) {
    const input = doc.getElementById(SEL.unitSelectInput(index));
    if (input && input.value) return input.value.toUpperCase() === 'C';

    const span = doc.getElementById(SEL.unitSelectButton(index));
    if (!span) return false;
    return /CheckBoxChecked/i.test(span.className);
  }

  async function ensureRowSelected(doc, index, label) {
    if (isRowSelected(doc, index)) return 'already ticked';

    // The grid's own client API is cleaner than synthesising a click, where
    // DevExpress has published the object under the grid's name.
    const grid = window[SEL.projectGrid] || window.GridUnit;
    if (grid && typeof grid.SelectRow === 'function') {
      try {
        grid.SelectRow(index, true);
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          await sleep(200);
          if (isRowSelected(doc, index)) return 'ticked via grid API';
        }
      } catch (err) {
        /* fall through to clicking the checkbox */
      }
    }

    const box = doc.getElementById(SEL.unitSelectButton(index));
    await pressUntil(box, () => isRowSelected(doc, index), label);
    return 'ticked';
  }

  /* --------------------------------------------------------------- runner */

  const Runner = {
    cancelled: false,

    async exportUnit(index, options) {
      const doc = document;
      const reportId = SEL.unitReportButton(index);

      // An absent report button means the grid has run out of rows.
      if (!doc.getElementById(reportId)) return { done: true };

      // Tick this unit's box first. The portal ties the report to the selected
      // row, so skipping this can produce the wrong unit's report rather than
      // an obvious failure.
      const how = await ensureRowSelected(doc, index, `Unit ${index + 1} checkbox`);
      if (how !== 'already ticked') UI.log(`  ${how}`, 'muted');

      await pressById(doc, reportId, `Unit ${index + 1} report button`);

      // 1. Options dialog — which sections the report includes.
      const optionsFrame = await waitFor(`${SEL.optionsDialog} iframe`);
      const optionsDoc = await frameDocument(optionsFrame);

      if (options.fanCurve) {
        const fanCurve = await waitFor(SEL.optFanCurve, { root: optionsDoc });
        await press(fanCurve, 'Fan curve checkbox');
        await sleep(TIMEOUT.settle);
      }
      if (options.listPrice) {
        const listPrice = await waitFor(SEL.optListPrice, { root: optionsDoc });
        await press(listPrice, 'List price checkbox');
        await sleep(TIMEOUT.settle);
      }

      const generate = await waitFor(SEL.generateButton);
      await press(generate, 'Generate report button');

      // 2. Report viewer — switch the export format, then save.
      const reportFrame = await waitFor(`${SEL.reportDialog} iframe`);
      const reportDoc = await frameDocument(reportFrame);
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

      const save = await waitFor(SEL.saveButton, { root: reportDoc });
      await press(save, 'Save button');
      await sleep(TIMEOUT.download);

      // 3. Close the viewer so the grid is interactive for the next unit.
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
    root: null,
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

      this.root = shadow;
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

  /* Exposed for console debugging when a step stalls. From the Daikin page:
       TNAHU.expand()        - expand the first project row
       TNAHU.selected(0)     - is unit 1 ticked?
       TNAHU.tick(0)         - tick it, verified
       TNAHU.try('SomeId')   - report what is found, then try to click it
       TNAHU.selectors       - the ids the run depends on                    */
  window.TNAHU = {
    selectors: SEL,
    press: press,
    expand: () => ensureProjectExpanded(document),
    selected: (i) => isRowSelected(document, i),
    tick: (i) => ensureRowSelected(document, i, `Unit ${i + 1} checkbox`),
    async try(id, doc) {
      const target = (doc || document).getElementById(id);
      if (!target) {
        console.log(`#${id} not found in this document — check you are in the right frame.`);
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
})();
