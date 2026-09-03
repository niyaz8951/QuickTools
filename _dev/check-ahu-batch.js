/* Regression check for the AHU Batch Report Export merge.
   Run from the repo root: node check-merge.js
   No arguments, no network. Exits non-zero on the first real failure. */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = process.argv[2] || '.';
const TOOL = 'tools/ahu-report-batch';
let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

console.log('\nFiles');
for (const f of ['index.html', 'styles.css', 'daikin-ahu-batch.user.js']) {
  check(`${TOOL}/${f} exists`, fs.existsSync(path.join(ROOT, TOOL, f)));
}

console.log('\nRegistration');
const globalJs = read('assets/js/global.js');
const homeHtml = read('index.html');
check('NAV entry present', /href: 'tools\/ahu-report-batch\/'/.test(globalJs));
check('home TOOLS entry present', /href: 'tools\/ahu-report-batch\/'/.test(homeHtml));

// Every icon a page asks for must already be a registry key — an unknown key
// silently falls back to a blank square rather than erroring.
const registryKeys = (globalJs.match(/^\s{4}'?[\w-]+'?:\s*'</gm) || [])
  .map((line) => line.trim().split(':')[0].replace(/'/g, ''));
const homeIcons = [...homeHtml.matchAll(/icon:\s*'([\w-]+)'/g)].map((m) => m[1]);
for (const key of new Set(homeIcons)) {
  check(`icon "${key}" is registered`, registryKeys.includes(key));
}

console.log('\nTool page');
const toolHtml = read(`${TOOL}/index.html`);
const dom = new JSDOM(toolHtml);
const doc = dom.window.document;

check('shared header placeholder', !!doc.querySelector('header[data-site-header]'));
check('shared footer placeholder', !!doc.querySelector('footer[data-site-footer]'));
check('header not hand-rolled', !doc.querySelector('.site-header__inner'));
check('skip link', !!doc.querySelector('a.skip-link[href="#main"]'));
check('main#main.wrap', !!doc.querySelector('main#main.wrap'));
check('page-head block', !!doc.querySelector('.page-head h1'));
check('single h1', doc.querySelectorAll('h1').length === 1);
check('noindex set', /noindex/.test(toolHtml));

const scripts = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
check('loads global.js by relative path', scripts.includes('../../assets/js/global.js'));
check('no absolute /assets paths', !/["'(]\/assets\//.test(toolHtml),
  'absolute paths break project-subfolder hosting');

const sheets = [...doc.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute('href'));
check('loads global.css', sheets.includes('../../assets/css/global.css'));
check('loads tool styles', sheets.includes('styles.css'));

// Icon placeholders must name keys the registry actually has.
for (const node of doc.querySelectorAll('[data-icon]')) {
  const key = node.getAttribute('data-icon');
  check(`page icon "${key}" is registered`, registryKeys.includes(key));
}

// Panels are labelled, and every label target exists.
for (const section of doc.querySelectorAll('section.panel')) {
  const id = section.getAttribute('aria-labelledby');
  check(`panel labelled by #${id}`, !!id && !!doc.getElementById(id));
}

console.log('\nAccessibility');
const install = doc.querySelector('#btn-install');
check('install link is an anchor', install && install.tagName === 'A',
  'a download must be a link, not a button');
check('copy control is a button', doc.querySelector('button#btn-copy'));
check('status region is live', !!doc.querySelector('#status[aria-live]'));
check('source block is focusable', doc.querySelector('.arb-source[tabindex]'));

console.log('\nTokens');
const css = read(`${TOOL}/styles.css`);
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
// Raw hex, rgb() or px lengths would drift from the token system. Bare 0 and
// unitless numbers are fine, as are em-relative font sizes.
const rawColour = declarations.match(/:\s*(#[0-9a-f]{3,8}|rgba?\()/gi) || [];
check('no hardcoded colours', rawColour.length === 0, rawColour.join(', '));

// Raw px is site convention in three places only: hairline borders, media
// query breakpoints, and pixel caps on scrolling panes. Spacing, radius and
// type must come from tokens. Anything else is drift.
const BREAKPOINTS = [560, 720, 860];
const spacingPx = declarations
  .replace(/@media[^{]*\{/g, '')
  .replace(/(?:border|outline)[^;]*;/g, '')
  .replace(/max-height:[^;]*;/g, '')
  .match(/[:\s]\d+px/g) || [];
check('no hardcoded spacing or type px', spacingPx.length === 0, spacingPx.join(', '));

const usedBreakpoints = [...declarations.matchAll(/@media \(max-width:\s*(\d+)px\)/g)]
  .map((m) => Number(m[1]));
const offScale = usedBreakpoints.filter((bp) => !BREAKPOINTS.includes(bp));
check('breakpoints match the site scale', offScale.length === 0,
  `${offScale.join(', ')} not in ${BREAKPOINTS.join('/')}`);

const tokensUsed = [...new Set((declarations.match(/var\((--[\w-]+)/g) || [])
  .map((m) => m.slice(4)))];
const globalCss = read('assets/css/global.css');
for (const token of tokensUsed) {
  check(`${token} defined in global.css`, globalCss.includes(`${token}:`));
}

console.log('\nUserscript');
const userJs = read(`${TOOL}/daikin-ahu-batch.user.js`);
check('parses as JS', (() => {
  try { new (require('vm').Script)(userJs); return true; } catch { return false; }
})());
check('metadata block present', /==UserScript==[\s\S]*==\/UserScript==/.test(userJs));

// The dialogs load from a different host (tools4), so the script must run in
// those frames too — but every @match still has to stay inside the vendor's
// domain, and none may widen to all sites.
const match = [...userJs.matchAll(/@match\s+(\S+)/g)].map((m) => m[1]);
check('has @match rules', match.length > 0);
check('every @match stays on daikinapplied.eu',
  match.every((m) => /^https:\/\/[^/]*daikinapplied\.eu\//.test(m)), match.join(' '));
check('covers the project list',
  match.some((m) => /ManageProjects/.test(m)), match.join(' '));
check('covers the report dialogs',
  match.some((m) => /\/Report\//.test(m)), match.join(' '));
check('no wildcard host match', !/@match\s+\S*:\/\/\*\/|@include/.test(userJs));

// Cross-frame messages must be origin-checked in both directions, or any page
// could drive the frames.
check('validates message origin', /ORIGIN_OK\.test\(event\.origin\)/.test(userJs));
check('origin pattern is anchored', /\^https:\\\/\\\/\[a-z0-9-\]\+\\\.daikinapplied\\\.eu\$/.test(userJs));
check('replies target a specific origin, not "*"',
  !/postMessage\([^)]*\btype: 'select-done'[^)]*'\*'\)/.test(userJs));
check('@grant none', /@grant\s+none/.test(userJs));

// The script must not reach back to Thinkneering at runtime — it runs on a
// page holding a live vendor session.
check('no outbound calls to thinkneering', !/thinkneering\.com\/\S/.test(
  userJs.replace(/\/\/ @namespace.*/g, '')));

// Selectors live in one block so a portal rename is a single-file fix.
check('selectors collected in SEL', /const SEL = \{[\s\S]*?\};/.test(userJs));

console.log(
  failures === 0
    ? '\nAll checks passed.\n'
    : `\n${failures} check${failures === 1 ? '' : 's'} failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
