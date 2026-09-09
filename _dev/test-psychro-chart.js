/* Thinkneering — psychrometric chart renderer checks.
   Plain node, no dependencies:  node _dev/test-psychro-chart.js

   The renderer produces a string of SVG, so it can be exercised without a
   browser. What is checked is the class of fault that makes a chart fail
   silently rather than loudly: a NaN inside path data, which browsers discard
   without complaint and which leaves an empty chart and no error anywhere. */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..', 'tools', 'psychrometric-chart');

/* chart.js expects TN.psychro on the global, exactly as the page provides it. */
var sandbox = { console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(DIR, 'psychro.js'), 'utf8'), sandbox, { filename: 'psychro.js' });
vm.runInContext(fs.readFileSync(path.join(DIR, 'chart.js'), 'utf8'), sandbox, { filename: 'chart.js' });

var P = sandbox.TN.psychro;
var C = sandbox.TN.psychroChart;

var pass = 0;
var fail = 0;
var failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? '\n      ' + extra : '')); }
}

function pt(label, i, t, mode, v, p) {
  return {
    label: label,
    colour: '--chart-' + ((i % 8) + 1),
    state: P.state(t, mode, v, p)
  };
}

var P_SEA = 101.325;
var ALL_LAYERS = { rh: true, wetBulb: true, enthalpy: true, volume: true, comfort: true, protractor: true };

function baseOpts(extra) {
  return Object.assign({
    pressure: P_SEA,
    rangeMode: 'auto',
    layers: ALL_LAYERS,
    activeSegment: 0,
    showAdp: true,
    showLegs: true,
    shr: 0.7
  }, extra || {});
}

/* A number that never made it into a coordinate is the failure this exists
   for: browsers drop the whole path and draw nothing, with no console error. */
function findBadNumbers(svg) {
  var bad = [];
  ['NaN', 'undefined', 'Infinity', 'null'].forEach(function (token) {
    var i = svg.indexOf(token);
    if (i >= 0) { bad.push(token + ' near: ' + svg.slice(Math.max(0, i - 60), i + 40)); }
  });
  return bad;
}

/* Rough tag balance check — enough to catch an unclosed group, which would
   swallow every layer drawn after it. */
function tagBalance(svg) {
  var opens = svg.match(/<(?!\/)([a-zA-Z]+)(?:\s[^>]*?)?(?<!\/)>/g) || [];
  var closes = svg.match(/<\/[a-zA-Z]+>/g) || [];
  return opens.length - closes.length;
}

console.log('Chart renderer');

/* ------------------------------------------------------- a typical chain */
var chain = [
  pt('Outdoor air', 0, 46, 'wb', 30, P_SEA),
  pt('Mixed', 1, 29.5, 'rh', 55, P_SEA),
  pt('Off coil', 2, 13, 'rh', 95, P_SEA),
  pt('Supply', 3, 14.6, 'w', 8.6, P_SEA),
  pt('Room', 4, 24, 'rh', 50, P_SEA)
];
chain.forEach(function (p, i) { ok('chain state ' + i + ' solves', p.state.ok, p.state.error); });

var out = C.render(chain, baseOpts());
ok('render returns svg markup', typeof out.svg === 'string' && out.svg.length > 4000);
ok('no NaN or undefined in the markup', findBadNumbers(out.svg).length === 0,
   findBadNumbers(out.svg)[0]);
ok('tags balance', tagBalance(out.svg) === 0, 'delta ' + tagBalance(out.svg));

/* Every layer that was switched on must actually appear. */
ok('saturation curve drawn', out.svg.indexOf('psy-sat') >= 0);
ok('relative humidity lines drawn', out.svg.indexOf('psy-line--rh') >= 0);
ok('wet bulb lines drawn', out.svg.indexOf('psy-line--wb') >= 0);
ok('enthalpy lines drawn', out.svg.indexOf('psy-line--h') >= 0);
ok('specific volume lines drawn', out.svg.indexOf('psy-line--v') >= 0);
ok('enthalpy scale drawn', out.svg.indexOf('psy-hscale-tick') >= 0);
ok('comfort zone drawn', out.svg.indexOf('psy-comfort') >= 0);
ok('protractor drawn', out.svg.indexOf('psy-prot-face') >= 0);
ok('protractor needle follows the ratio', out.svg.indexOf('psy-prot-needle') >= 0);
ok('clip path defined', out.svg.indexOf('clipPath id="psy-body"') >= 0);
ok('clip path is used', out.svg.indexOf('clip-path="url(#psy-body)"') >= 0);
ok('the clip path was substituted, not left as a placeholder', out.svg.indexOf('{BODY}') < 0);

/* One process line per gap between states, and one marker per point. */
var processCount = (out.svg.match(/class="psy-process/g) || []).length;
ok('four process lines for five states', processCount === 4, 'got ' + processCount);
var pointCount = (out.svg.match(/class="psy-pt"/g) || []).length;
ok('five point markers', pointCount === 5, 'got ' + pointCount);

/* Colours are tokens, never literals. This is the rule the whole design
   system rests on, so it is worth asserting rather than trusting. */
/* A `#` that follows `&` is an HTML entity such as &#176; for the degree
   sign, not a colour, so it is excluded rather than reported. */
ok('no hex colours anywhere in the markup', !/(^|[^&\w])#[0-9a-fA-F]{3,8}\b/.test(out.svg),
   (out.svg.match(/(^|[^&\w])#[0-9a-fA-F]{3,8}\b/) || [])[0]);
ok('no rgb() colours in the markup', out.svg.indexOf('rgb(') < 0);
ok('series colours come from chart tokens', out.svg.indexOf('var(--chart-') >= 0);

/* ----------------------------------------------------- every range preset */
console.log('Range presets');
Object.keys(C.PRESETS).concat(['auto']).forEach(function (mode) {
  var r = C.render(chain, baseOpts({ rangeMode: mode }));
  ok('range "' + mode + '" renders cleanly', findBadNumbers(r.svg).length === 0,
     findBadNumbers(r.svg)[0]);
  ok('range "' + mode + '" balances', tagBalance(r.svg) === 0);
  ok('range "' + mode + '" draws the saturation curve', r.svg.indexOf('psy-sat') >= 0);
});

/* ------------------------------------------------------ layers one by one */
console.log('Layers toggled individually');
Object.keys(ALL_LAYERS).forEach(function (key) {
  var only = {};
  only[key] = true;
  var r = C.render(chain, baseOpts({ layers: only }));
  ok('layer "' + key + '" alone renders cleanly', findBadNumbers(r.svg).length === 0);
  ok('layer "' + key + '" alone balances', tagBalance(r.svg) === 0);
});
var none = C.render(chain, baseOpts({ layers: {}, showAdp: false, showLegs: false }));
ok('no layers at all still draws the points and the curve',
   none.svg.indexOf('psy-sat') >= 0 && none.svg.indexOf('class="psy-pt"') >= 0);
ok('no layers means no property lines', none.svg.indexOf('psy-line--rh') < 0);

/* ------------------------------------------------------------ edge cases */
console.log('Edge cases');

ok('an empty chart renders', (function () {
  var r = C.render([], baseOpts());
  return typeof r.svg === 'string' && r.svg.indexOf('psy-sat') >= 0 && findBadNumbers(r.svg).length === 0;
})());

ok('a single point renders with no process line', (function () {
  var r = C.render([pt('Only', 0, 25, 'rh', 50, P_SEA)], baseOpts());
  return r.svg.indexOf('class="psy-process') < 0 && findBadNumbers(r.svg).length === 0;
})());

ok('an unsolved state is skipped rather than breaking the chart', (function () {
  var mixed = [pt('Good', 0, 25, 'rh', 50, P_SEA), pt('Bad', 1, 25, 'rh', 150, P_SEA)];
  var r = C.render(mixed, baseOpts());
  return findBadNumbers(r.svg).length === 0 && (r.svg.match(/class="psy-pt"/g) || []).length === 1;
})());

ok('two identical states do not produce a degenerate line', (function () {
  var same = [pt('A', 0, 24, 'rh', 50, P_SEA), pt('B', 1, 24, 'rh', 50, P_SEA)];
  var r = C.render(same, baseOpts());
  return findBadNumbers(r.svg).length === 0;
})());

ok('a saturated state at the curve renders', (function () {
  var r = C.render([pt('Saturated', 0, 20, 'rh', 100, P_SEA)], baseOpts());
  return findBadNumbers(r.svg).length === 0;
})());

/* Perfectly dry air has no dew point but does have a wet bulb. A single NaN
   escaping from that asymmetry used to poison the auto range and collapse the
   entire chart to one degenerate clip path. */
ok('a very dry state at 0 g/kg renders', (function () {
  var r = C.render([pt('Bone dry', 0, 30, 'w', 0, P_SEA)], baseOpts());
  return findBadNumbers(r.svg).length === 0;
})());
ok('bone dry air still has a wet bulb', (function () {
  var s = P.state(30, 'w', 0, P_SEA);
  return s.ok && isFinite(s.wb) && s.wb > 0 && s.wb < 30;
})(), 'wb = ' + P.state(30, 'w', 0, P_SEA).wb);
ok('bone dry air has no dew point', !isFinite(P.state(30, 'w', 0, P_SEA).dp));

/* Altitude changes the saturation curve, so every layer has to be redrawn
   against the site pressure rather than a baked-in sea-level one. */
console.log('Altitude');
var pRiyadh = P.pressureAtAltitude(612);
var alt = C.render([
  pt('Outdoor air', 0, 44, 'wb', 22, pRiyadh),
  pt('Off coil', 1, 11, 'rh', 95, pRiyadh)
], baseOpts({ pressure: pRiyadh }));
ok('altitude chart renders cleanly', findBadNumbers(alt.svg).length === 0, findBadNumbers(alt.svg)[0]);
ok('altitude chart balances', tagBalance(alt.svg) === 0);
ok('the saturation curve moved with the pressure', (function () {
  var sea = C.render([pt('x', 0, 30, 'rh', 50, P_SEA)], baseOpts());
  var a = sea.svg.match(/class="psy-sat" d="([^"]{0,80})/)[1];
  var b = alt.svg.match(/class="psy-sat" d="([^"]{0,80})/)[1];
  return a !== b;
})());

/* -------------------------------------------------------- the auto range */
console.log('Auto range holds the data');

/* This is the fix for a point silently falling off a fixed chart. A 46 C Gulf
   design condition must be inside the frame, not clipped away. */
var hot = [pt('Design day', 0, 46, 'wb', 30, P_SEA)];
var r1 = C.autoRange(hot.map(function (p) { return p.state; }), P_SEA);
ok('a 46 C design condition is inside the auto range',
   r1.tMax > 46 && r1.wMax > hot[0].state.W * 1000,
   'range ' + JSON.stringify(r1) + ' vs W = ' + (hot[0].state.W * 1000).toFixed(2));

var cold = [pt('Winter', 0, -18, 'rh', 60, P_SEA)];
var r2 = C.autoRange(cold.map(function (p) { return p.state; }), P_SEA);
ok('a sub-zero condition is inside the auto range', r2.tMin < -18, JSON.stringify(r2));

var spread = C.autoRange(chain.map(function (p) { return p.state; }), P_SEA);
ok('the whole chain fits the auto range', chain.every(function (p) {
  return p.state.db >= spread.tMin && p.state.db <= spread.tMax &&
         p.state.W * 1000 <= spread.wMax;
}), JSON.stringify(spread));

/* The view has to invert exactly, or the pointer readout lies. */
console.log('The view inverts');
var view = C.makeView({ tMin: 0, tMax: 50, wMin: 0, wMax: 30 }, P_SEA);
[[0, 0], [25, 12], [50, 30], [13.4, 8.6]].forEach(function (c) {
  var back = view.t(view.x(c[0]));
  var backW = view.w(view.y(c[1]));
  ok('x inverts at t = ' + c[0], Math.abs(back - c[0]) < 1e-9);
  ok('y inverts at W = ' + c[1], Math.abs(backW - c[1]) < 1e-9);
});

/* ------------------------------------------------------------- report */
console.log('\n' + '-'.repeat(60));
if (fail === 0) {
  console.log(pass + ' checks passed.');
} else {
  console.log(pass + ' passed, ' + fail + ' FAILED:\n');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exitCode = 1;
}
