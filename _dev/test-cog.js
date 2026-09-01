/* Headless checks for tools/centre-of-gravity/cog.js
   Run with: node test-cog.js
   No dependencies. The tool file exposes its maths on TN.cog and only boots
   when a real document is present, so it loads cleanly here. */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var source = fs.readFileSync(path.join(__dirname, '..', 'tools', 'centre-of-gravity', 'cog.js'), 'utf8');
var sandbox = { console: console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'cog.js' });

var cog = sandbox.TN && sandbox.TN.cog;
var failures = 0;
var checks = 0;

function near(actual, expected, tol, label) {
  checks++;
  var ok = Math.abs(actual - expected) <= (tol === undefined ? 1e-6 : tol);
  if (!ok) {
    failures++;
    console.error('FAIL ' + label + ': got ' + actual + ', expected ' + expected);
  }
  return ok;
}

function assert(condition, label) {
  checks++;
  if (!condition) {
    failures++;
    console.error('FAIL ' + label);
  }
}

function block(x, y, z, dx, dy, dz, w) {
  return { name: 'b', x: x, y: y, z: z, dx: dx, dy: dy, dz: dz, w: w, on: true };
}

function equilibrium(supports, loads, weight, cgx, cgy, label) {
  var sum = 0, mx = 0, my = 0;
  for (var i = 0; i < supports.length; i++) {
    sum += loads[i];
    mx += loads[i] * supports[i].x;
    my += loads[i] * supports[i].y;
  }
  var tol = Math.max(1e-6, weight * 1e-9);
  near(sum, weight, tol, label + ' vertical balance');
  near(mx, weight * cgx, Math.max(1e-3, Math.abs(weight * cgx) * 1e-9), label + ' moment about Y');
  near(my, weight * cgy, Math.max(1e-3, Math.abs(weight * cgy) * 1e-9), label + ' moment about X');
}

assert(!!cog, 'TN.cog is exposed');

/* --- centre of gravity --------------------------------------------------- */

var twoBlocks = cog.computeCog([
  block(0, 0, 0, 100, 100, 100, 50),
  block(900, 0, 0, 100, 100, 100, 50)
], 'corner');
near(twoBlocks.weight, 100, 1e-9, 'two equal blocks total weight');
near(twoBlocks.x, 500, 1e-9, 'two equal blocks CG X');
near(twoBlocks.y, 50, 1e-9, 'two equal blocks CG Y');

var weighted = cog.computeCog([
  block(0, 0, 0, 0, 0, 0, 300),
  block(1000, 0, 0, 0, 0, 0, 100)
], 'corner');
near(weighted.x, 250, 1e-9, 'point masses biased towards the heavy end');

var centreMode = cog.computeCog([block(500, 500, 500, 200, 200, 200, 10)], 'centre');
near(centreMode.x, 500, 1e-9, 'centre position mode does not shift the block');

var cornerMode = cog.computeCog([block(500, 500, 500, 200, 200, 200, 10)], 'corner');
near(cornerMode.x, 600, 1e-9, 'corner position mode adds half the size');

var excluded = cog.computeCog([
  block(0, 0, 0, 0, 0, 0, 100),
  Object.assign(block(1000, 0, 0, 0, 0, 0, 100), { on: false })
], 'corner');
near(excluded.weight, 100, 1e-9, 'excluded rows are left out');
near(excluded.x, 0, 1e-9, 'excluded rows do not move the CG');

assert(cog.computeCog([], 'corner').ok === false, 'no blocks means no result');

/* --- support loads ------------------------------------------------------- */

var square = [
  { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }
];

var centred = cog.solveReactions(square, 4000, 500, 500, true);
assert(centred.ok, 'square supports solve');
[0, 1, 2, 3].forEach(function (i) {
  near(centred.loads[i], 1000, 1e-6, 'centred load splits four ways, support ' + i);
});

var offset = cog.solveReactions(square, 4000, 800, 500, true);
equilibrium(square, offset.loads, 4000, 800, 500, 'offset square');
assert(offset.loads[1] > offset.loads[0], 'load shifts to the near support');

/* Two supports fall back to the lever rule. */
var pair = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
var lever = cog.solveReactions(pair, 1000, 250, 0, true);
near(lever.loads[0], 750, 1e-6, 'lever rule far support');
near(lever.loads[1], 250, 1e-6, 'lever rule near support');

var atSupport = cog.solveReactions(pair, 1000, 1000, 0, true);
near(atSupport.loads[0], 0, 1e-6, 'CG over a support unloads the other one');
near(atSupport.loads[1], 1000, 1e-6, 'CG over a support carries everything');

/* Three supports are statically determinate, so the answer is exact. */
var tri = [{ x: 0, y: 0 }, { x: 1200, y: 0 }, { x: 0, y: 900 }];
var triSolve = cog.solveReactions(tri, 900, 400, 300, true);
equilibrium(tri, triSolve.loads, 900, 400, 300, 'triangle');
near(triSolve.loads[0], 300, 1e-6, 'centroid load on a triangle is even, support 0');
near(triSolve.loads[1], 300, 1e-6, 'centroid load on a triangle is even, support 1');
near(triSolve.loads[2], 300, 1e-6, 'centroid load on a triangle is even, support 2');

/* A ten-point rail pattern, the shape used by the chiller preset. */
var rails = [];
[540, 2700, 4860, 7020, 9180].forEach(function (x) {
  rails.push({ x: x, y: 116 });
  rails.push({ x: x, y: 2116 });
});
var railSolve = cog.solveReactions(rails, 9390, 4300, 1100, true);
assert(railSolve.ok, 'rail pattern solves');
equilibrium(rails, railSolve.loads, 9390, 4300, 1100, 'rail pattern');
assert(railSolve.loads.every(function (v) { return v > 0; }), 'rail pattern has no uplift');

/* Uplift: the CG hangs outside the pattern, so a support has to be dropped. */
var uplift = cog.solveReactions(square, 1000, 1400, 500, true);
assert(uplift.lifted.length > 0, 'a support lifts off when the CG is outside');
var stillActive = uplift.active.map(function (i) { return square[i]; });
var activeLoads = uplift.active.map(function (i) { return uplift.loads[i]; });
equilibrium(stillActive, activeLoads, 1000, 1400, 500, 'after redistribution');

var noRedistribute = cog.solveReactions(square, 1000, 1400, 500, false);
assert(noRedistribute.negative.length > 0, 'without redistribution the uplift is reported');
equilibrium(square, noRedistribute.loads, 1000, 1400, 500, 'raw plane solution');

var single = cog.solveReactions([{ x: 10, y: 20 }], 500, 40, 60, true);
near(single.loads[0], 500, 1e-9, 'one support carries everything');
near(single.offset, 50, 1e-6, 'one support reports the offset to the CG');

/* --- stability ----------------------------------------------------------- */

var inside = cog.stabilityMargin(square, 500, 500);
assert(inside.ok && inside.inside, 'CG inside the support outline');
near(inside.margin, 500, 1e-6, 'margin to the nearest edge');

var outside = cog.stabilityMargin(square, 1200, 500);
assert(outside.ok && !outside.inside, 'CG outside the support outline');
near(outside.margin, -200, 1e-6, 'negative margin when outside');

var hull = cog.convexHull([
  { x: 0, y: 0 }, { x: 500, y: 500 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }
]);
near(hull.length, 4, 0, 'interior points are dropped from the outline');

var line = cog.stabilityMargin([{ x: 0, y: 0 }, { x: 100, y: 0 }], 50, 0);
assert(line.ok === false, 'two supports cannot form an outline');

/* --- report -------------------------------------------------------------- */

console.log((failures ? 'FAILED' : 'PASSED') + ': ' + (checks - failures) + '/' + checks + ' checks');
process.exit(failures ? 1 : 0);
