/* Thinkneering — sound level & NC engine checks.
   Plain node, no dependencies:  node _dev/test-sound.js

   sound.js is a DOM-bound IIFE, so the numerical core is re-stated here and
   checked against published reference values rather than against itself. Any
   change to a constant table in sound.js must be mirrored here, and the
   structural checks at the end guard the parts that cannot be re-stated:
   that the tool file carries the same tables, resolves every colour from a
   token, and pulls in nothing external.

   Reference values:
     - ANSI/ASA S12.2 for the NC curves
     - ASHRAE Handbook — Applications, Ch. 49 for the RC Mark II worked example
     - IEC 61672-1 for A-weighting
     - The user's own FWW medium-speed sheet, whose published overall dB(A)
       column is a check on the band data being A-weighted
     - A TAP duct path summary, whose SUM row is a check on unweighted data */

'use strict';

var fs = require('fs');
var path = require('path');

var SRC = fs.readFileSync(
  path.join(__dirname, '../tools/sound-level-calculator/sound.js'), 'utf8');
var CSS = fs.readFileSync(
  path.join(__dirname, '../tools/sound-level-calculator/styles.css'), 'utf8');
var HTML = fs.readFileSync(
  path.join(__dirname, '../tools/sound-level-calculator/index.html'), 'utf8');

var pass = 0, fail = 0, failures = [];

function near(name, got, want, tol) {
  if (isFinite(got) && Math.abs(got - want) <= tol) { pass++; return; }
  fail++;
  failures.push(name + ' — got ' + got + ', wanted ' + want + ' ±' + tol);
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? ' — ' + detail : ''));
}

// ------------------------------------------------------------- constants

var A_WT = [-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1];
var NC = {
  15: [47, 36, 29, 22, 17, 14, 12, 11],
  20: [51, 40, 33, 26, 22, 19, 17, 16],
  25: [54, 44, 37, 31, 27, 24, 22, 21],
  30: [57, 48, 41, 35, 31, 29, 28, 27],
  35: [60, 52, 45, 40, 36, 34, 33, 32],
  40: [64, 56, 50, 45, 41, 39, 38, 37],
  45: [67, 60, 54, 49, 46, 44, 43, 42],
  50: [71, 64, 58, 54, 51, 49, 48, 47],
  55: [74, 67, 62, 58, 56, 54, 53, 52],
  60: [77, 71, 67, 63, 61, 59, 58, 57],
  65: [80, 75, 71, 68, 66, 64, 63, 62]
};
var KEYS = Object.keys(NC).map(Number).sort(function (a, b) { return a - b; });

function logSum(a) {
  var s = 0;
  a.forEach(function (v) { if (isFinite(v)) s += Math.pow(10, v / 10); });
  return s > 0 ? 10 * Math.log10(s) : -Infinity;
}
function energyAvg(a) {
  var s = 0, n = 0;
  a.forEach(function (v) { if (isFinite(v)) { s += Math.pow(10, v / 10); n++; } });
  return n ? 10 * Math.log10(s / n) : NaN;
}
function r1(n) { return isFinite(n) ? Math.round(n * 10) / 10 : null; }

/* dBA over a 10-band array, indices 0..9 = 16 Hz .. 8 kHz. */
function dBA(b) {
  var w = [];
  b.forEach(function (v, i) { if (isFinite(v)) w.push(v + A_WT[i]); });
  return logSum(w);
}
/* dBA over an 8-band array starting at 63 Hz. */
function dBA8(b) { return dBA([NaN, NaN].concat(b)); }

function ncRating(lp) {
  var worst = -Infinity, gov = -1;
  for (var i = 2; i <= 9; i++) {
    if (!isFinite(lp[i])) continue;
    var col = i - 2, v = lp[i], nc = null, k;
    for (k = 0; k < KEYS.length - 1; k++) {
      var lo = NC[KEYS[k]][col], hi = NC[KEYS[k + 1]][col];
      if (v >= lo && v <= hi) {
        nc = KEYS[k] + (v - lo) / (hi - lo) * (KEYS[k + 1] - KEYS[k]);
        break;
      }
    }
    if (nc === null) {
      var first = NC[KEYS[0]][col], n = KEYS.length, last = NC[KEYS[n - 1]][col];
      nc = v < first
        ? KEYS[0] + (v - first) / ((NC[KEYS[1]][col] - first) / (KEYS[1] - KEYS[0]))
        : KEYS[n - 1] + (v - last) / ((last - NC[KEYS[n - 2]][col]) / (KEYS[n - 1] - KEYS[n - 2]));
    }
    if (nc > worst) { worst = nc; gov = i; }
  }
  return { value: worst, band: gov };
}

function rcMarkII(lp) {
  var level = (lp[5] + lp[6] + lp[7]) / 3;
  var contour = [level + 25, level + 25, level + 20, level + 15, level + 10,
    level + 5, level, level - 5, level - 10];
  var dev = [];
  for (var i = 0; i <= 8; i++) dev.push(isFinite(lp[i]) ? lp[i] - contour[i] : NaN);
  var LF = energyAvg(dev.slice(0, 3)),
    MF = energyAvg(dev.slice(3, 6)),
    HF = energyAvg(dev.slice(6, 9));
  var f = [r1(LF), r1(MF), r1(HF)].filter(function (v) { return v !== null; });
  var qai = Math.max.apply(null, f) - Math.min.apply(null, f);
  var vals = [LF, MF, HF], names = ['LF', 'MF', 'HF'], top = 0;
  for (i = 1; i < 3; i++) if (vals[i] > vals[top]) top = i;
  return {
    level: level, contour: contour, LF: LF, MF: MF, HF: HF, qai: qai,
    descriptor: (qai > 5 && vals[top] > 0) ? names[top] : 'N'
  };
}

function roomTerm(L, W, H, r, Q, alpha) {
  var S = 2 * (L * W + L * H + W * H);
  return 10 * Math.log10(Q / (4 * Math.PI * r * r) + 4 / (S * alpha / (1 - alpha)));
}
function barrierIL(d, f) {
  if (!d || d <= 0) return 0;
  return Math.min(Math.max(10 * Math.log10(3 + 20 * (2 * d * f / 343)), 0), 24);
}

console.log('Sound level & NC calculator\n' + '-'.repeat(60));

// --------------------------------------------- A-weighting and data sheets

/* The FWW sheets publish A-weighted bands. Log-summing them as published must
   reproduce the sheet's own overall dB(A) column — that is what proves the
   weighting, and getting it wrong is the single biggest error in the tool. */
near('FWW200VA inlet+rad sums to its published 55 dB(A)',
  logSum([23.4, 35.9, 45.2, 51.3, 49.8, 46.1, 39.1, 30.2]), 55, 0.2);
near('FWW600VA inlet+rad sums to its published 60 dB(A)',
  logSum([26.4, 41.7, 49.5, 55.3, 55.8, 51.4, 45.2, 37.9]), 60, 0.2);
near('FWW600VA outlet duct sums to its published 57 dB(A)',
  logSum([21.9, 35.8, 42.2, 48.0, 54.3, 50.0, 45.8, 41.2]), 57, 0.5);
near('FWW1000VA outlet duct sums to its published 62 dB(A)',
  logSum([29.4, 40.2, 47.0, 53.5, 59.2, 54.4, 51.5, 47.2]), 62, 0.5);

/* A TAP duct path summary publishes UNWEIGHTED bands, so the same sheet must
   be A-weighted before summing. Two conventions, two sheets — the tool has to
   handle both, which is why the weighting selector exists. */
near('TAP supply path SUM row A-weights to its published 40 dB(A)',
  dBA8([24, 29, 40, 36, 30, 27, 36, NaN]), 40, 0.3);
near('TAP total SUM row A-weights to its published 53 dB(A)',
  dBA8([55, 62, 54, 51, 44, 40, 46, NaN]), 53, 0.6);

/* Un-weighting must be the exact inverse. */
var lin600 = [26.4, 41.7, 49.5, 55.3, 55.8, 51.4, 45.2, 37.9]
  .map(function (v, i) { return v - A_WT[i + 2]; });
near('FWW600VA 63 Hz un-weights to 52.6', lin600[0], 52.6, 0.05);
near('FWW600VA 125 Hz un-weights to 57.8', lin600[1], 57.8, 0.05);
near('FWW600VA 2 kHz un-weights to 50.2', lin600[5], 50.2, 0.05);
ok('A-weighting is zero at 1 kHz', A_WT[6] === 0);

// ---------------------------------------------------------------- NC

function pad(b8) { return [NaN, NaN].concat(b8); }

near('an exact NC 30 curve rates NC 30', ncRating(pad(NC[30])).value, 30, 0.01);
near('an exact NC 25 curve rates NC 25', ncRating(pad(NC[25])).value, 25, 0.01);
near('an exact NC 55 curve rates NC 55', ncRating(pad(NC[55])).value, 55, 0.01);
near('the midpoint of NC 25 and NC 30 interpolates to 27.5',
  ncRating(pad(NC[25].map(function (v, i) { return (v + NC[30][i]) / 2; }))).value, 27.5, 0.4);

var spiked = NC[25].slice(); spiked[3] += 6;   // 500 Hz band index 3 of the 8
ok('a single raised band is identified as governing',
  ncRating(pad(spiked)).band === 5, 'expected band index 5 (500 Hz)');
ok('one band alone drives the whole rating', ncRating(pad(spiked)).value > 28);
ok('every NC curve falls monotonically with frequency', KEYS.every(function (k) {
  return NC[k].every(function (v, i) { return i === 0 || v <= NC[k][i - 1]; });
}));
ok('NC curves never cross each other', KEYS.every(function (k, n) {
  return n === 0 || NC[k].every(function (v, i) { return v > NC[KEYS[n - 1]][i]; });
}));

// ------------------------------------------------------- RC Mark II

/* ASHRAE Handbook — Applications, Ch. 49, worked example.
   Spectrum 16 Hz .. 4 kHz, published answer RC 35(LF) with QAI 7.2. */
var ex = [64, 65, 64, 57, 47, 40, 35, 30, 23, NaN];
var rc = rcMarkII(ex);
near('handbook example: RC level is 35', rc.level, 35, 0.01);
ok('handbook example: reference contour matches the published row',
  rc.contour.join(',') === '60,60,55,50,45,40,35,30,25', rc.contour.join(','));
near('handbook example: LF deviation factor is 6.6', rc.LF, 6.6, 0.05);
near('handbook example: MF deviation factor is 4.0', rc.MF, 4.0, 0.05);
near('handbook example: HF deviation factor is -0.6', rc.HF, -0.6, 0.05);
near('handbook example: quality assessment index is 7.2', rc.qai, 7.2, 0.05);
ok('handbook example: rated RC 35(LF)',
  rc.descriptor === 'LF', 'got ' + rc.descriptor);

/* A spectrum sitting exactly on its own reference contour is neutral with a
   zero index — the definitional case. */
var flat = [60, 60, 55, 50, 45, 40, 35, 30, 25, NaN];
near('a spectrum on its own contour has a zero index', rcMarkII(flat).qai, 0, 0.05);
ok('a spectrum on its own contour rates neutral', rcMarkII(flat).descriptor === 'N');

var hissy = [50, 50, 45, 40, 35, 30, 30, 30, 30, NaN];
ok('high frequency excess is flagged as hiss',
  rcMarkII(hissy).descriptor === 'HF', 'got ' + rcMarkII(hissy).descriptor);

// -------------------------------------------------------- propagation

near('a furnished guest room at 1.5 m gives about -6.5 dB',
  roomTerm(6, 4, 2.8, 1.5, 2, 0.20), -6.5, 0.5);
ok('a harder room returns a smaller reduction',
  roomTerm(6, 4, 2.8, 1.5, 2, 0.05) > roomTerm(6, 4, 2.8, 1.5, 2, 0.30));
ok('raising Q raises the direct field',
  roomTerm(6, 4, 2.8, 1.5, 4, 0.20) > roomTerm(6, 4, 2.8, 1.5, 2, 0.20));

var spread = function (r, Q) { return 10 * Math.log10(Q / (4 * Math.PI * r * r)); };
near('doubling the distance outdoors loses 6 dB', spread(30, 2) - spread(15, 2), -6.02, 0.02);
ok('no barrier gives no attenuation', barrierIL(0, 1000) === 0);
ok('barrier attenuation rises with frequency', barrierIL(0.3, 2000) > barrierIL(0.3, 250));
ok('barrier attenuation is capped at 24 dB', barrierIL(5, 8000) === 24);

// --------------------------------- source file structure and discipline

ok('sound.js carries all ten octave bands',
  /16,\s*31\.5,\s*63,\s*125,\s*250,\s*500,\s*1000,\s*2000,\s*4000,\s*8000/.test(SRC));
ok('sound.js A-weighting table matches IEC 61672-1',
  SRC.indexOf('-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1') >= 0);
ok('sound.js rates NC over 63 Hz to 8 kHz only',
  /NC_LO = 2, NC_HI = 9/.test(SRC));
ok('every element insertion loss array has ten values',
  (SRC.match(/il: \[[^\]]+\]/g) || []).every(function (m) {
    return m.split(',').length === 10;
  }));
ok('no attenuation is credited below 63 Hz',
  (SRC.match(/il: \[[^\]]+\]/g) || []).every(function (m) {
    var v = m.replace(/il: \[|\]/g, '').split(',').map(Number);
    /* branch splits are frequency-independent and legitimately non-zero */
    return (v[0] === 0 && v[1] === 0) || v.every(function (x) { return x === v[0]; });
  }));

ok('no hardcoded colours in sound.js', !/#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(SRC));
ok('no hardcoded colours in styles.css', !/#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(CSS));
ok('chart colours resolve from design tokens',
  (CSS.match(/\.snd-(grid|axis|nc|target|result|dot)[^{]*\{[^}]*var\(--color-/g) || []).length >= 6);
ok('no SVG presentation attribute carries a var()',
  !/(stroke|fill)="var\(/.test(SRC), 'var() does not resolve in SVG attributes');

ok('no browser storage is used', !/localStorage|sessionStorage|indexedDB/.test(SRC));
ok('no network calls', !/\bfetch\(|XMLHttpRequest|import\(/.test(SRC));
ok('the only external reference is the shared font stylesheet',
  (HTML.match(/https?:\/\/[^\s"'>]+/g) || []).every(function (u) {
    return /^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(u);
  }));

ok('the markup offers the three calculation modes',
  /value="indoor"/.test(HTML) && /value="outdoor"/.test(HTML) && /value="direct"/.test(HTML));
ok('direct mode skips the pressure-to-power conversion',
  /quantity === 'lp' && \$\('mode'\)\.value !== 'direct'/.test(SRC));
ok('direct mode contributes no propagation term',
  /direct \? 0 : \(indoor \? roomTerm\(i\) : outdoorTerm\(i\)\)/.test(SRC));
ok('direct mode is still rated against NC and RC',
  /var rate = direct \|\| indoor;/.test(SRC));

ok('page uses the shared header and footer', /data-site-header/.test(HTML) && /data-site-footer/.test(HTML));
ok('page links global.css before its own stylesheet',
  HTML.indexOf('assets/css/global.css') < HTML.indexOf('styles.css'));
ok('page carries a skip link', /class="skip-link"/.test(HTML));
ok('every tool rule is scoped to an snd- class',
  (CSS.match(/^\.[^{]+/gm) || []).every(function (sel) {
    /* A rule may lead with a global class only if it still targets an
       snd- element, e.g. `.notice--danger .snd-verdict__title`. */
    return /\.snd-/.test(sel);
  }));

/* Every id the script reaches for must exist in the markup, except the ones
   the script builds itself inside the path blocks. */
var htmlIds = {};
(HTML.match(/id="([^"]+)"/g) || []).forEach(function (m) {
  htmlIds[m.slice(4, -1)] = true;
});
var missing = [];
(SRC.match(/\$\('([a-z0-9-]+)'\)/g) || []).forEach(function (m) {
  var id = m.slice(3, -2);
  if (!htmlIds[id] && !/^p[ab]-/.test(id) && missing.indexOf(id) < 0) missing.push(id);
});
ok('every static id the script uses exists in the markup',
  missing.length === 0, missing.join(', '));

// --------------------------------------------------- site integration

var GJS = fs.readFileSync(path.join(__dirname, '../assets/js/global.js'), 'utf8');
var HOME = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
ok('the tool is registered in the shared nav',
  /tools\/sound-level-calculator\//.test(GJS));
ok('the acoustic icon is in the global registry', /acoustic:/.test(GJS));
ok('the icon is not inlined in the tool', !/acoustic:/.test(SRC));
ok('the tool has a tile on the home page',
  /tools\/sound-level-calculator\//.test(HOME) && /icon: 'acoustic'/.test(HOME));

console.log('\n' + '-'.repeat(60));
if (fail === 0) {
  console.log(pass + ' checks passed.');
} else {
  console.log(pass + ' passed, ' + fail + ' FAILED:\n');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exitCode = 1;
}
