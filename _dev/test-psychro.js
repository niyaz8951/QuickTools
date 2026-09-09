/* Thinkneering — psychrometric engine checks.
   Plain node, no dependencies:  node _dev/test-psychro.js

   Reference values come from the ASHRAE Handbook — Fundamentals (2017),
   Chapter 1: the saturation-pressure table, the worked examples, and the
   defining relations themselves (a round trip through an inverse has to land
   back where it started, whatever the tables say).

   Tolerances are stated per check rather than globally, because they mean
   different things: a saturation pressure is checked to five figures against
   a published table, whereas an example worked to two decimals in the
   Handbook can only be checked to the precision it was printed at. */

'use strict';

var P = require('../tools/psychrometric-chart/psychro.js');

var pass = 0;
var fail = 0;
var failures = [];

function near(name, got, want, tol) {
  var ok = isFinite(got) && Math.abs(got - want) <= tol;
  if (ok) { pass++; } else {
    fail++;
    failures.push(name + '\n      got  ' + got + '\n      want ' + want + ' ±' + tol);
  }
}

function ok(name, cond) {
  if (cond) { pass++; } else { fail++; failures.push(name); }
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------- saturation pressure */
section('Saturation pressure — ASHRAE Eq 5 and 6');

/* The normal boiling point is the cheapest possible proof that the Eq 6
   constants are typed correctly: any single digit wrong moves this. Water
   boils at 99.974 C under one standard atmosphere on ITS-90, not at a round
   100 C, so that is the temperature to check against 101.325 kPa. */
near('water boils at 99.974 C under one atmosphere', P.satPressure(99.974), 101.325, 0.005);
near('pws(0 C)', P.satPressure(0), 0.61115, 0.0002);
near('pws(5 C)', P.satPressure(5), 0.87257, 0.0003);
near('pws(10 C)', P.satPressure(10), 1.22821, 0.0004);
near('pws(20 C)', P.satPressure(20), 2.33927, 0.0008);
near('pws(25 C)', P.satPressure(25), 3.16955, 0.001);
near('pws(30 C)', P.satPressure(30), 4.24645, 0.0015);
near('pws(40 C)', P.satPressure(40), 7.38449, 0.003);
near('pws(50 C)', P.satPressure(50), 12.3516, 0.005);
/* Below zero the correlation switches to sublimation over ice — Eq 5. */
near('pws(-10 C), over ice', P.satPressure(-10), 0.25990, 0.0002);
near('pws(-20 C), over ice', P.satPressure(-20), 0.10326, 0.0001);
ok('pws increases monotonically across the switch at 0 C',
   P.satPressure(-0.01) < P.satPressure(0) && P.satPressure(0) < P.satPressure(0.01));

/* ---------------------------------------------------- site pressure */
section('Barometric pressure with altitude — ASHRAE Eq 3');

near('sea level', P.pressureAtAltitude(0), 101.325, 1e-9);
near('500 m', P.pressureAtAltitude(500), 95.461, 0.01);
near('1000 m', P.pressureAtAltitude(1000), 89.875, 0.01);
near('Riyadh, 612 m', P.pressureAtAltitude(612), 94.19, 0.05);
near('altitude round trip', P.altitudeAtPressure(P.pressureAtAltitude(1500)), 1500, 1e-6);

/* -------------------------------------------- ASHRAE worked example 1 */
section('ASHRAE Ch.1 Example 1 — 40 C dry bulb, 20 C wet bulb, sea level');

var ex1 = P.state(40, 'wb', 20, 101.325);
ok('example 1 state solves', ex1.ok);
near('humidity ratio W', ex1.W, 0.0065, 0.0002);
near('relative humidity', ex1.rh, 14.0, 0.6);
/* Dew point is checked by its definition rather than against a printed
   figure: the vapour pressure of the state must equal the saturation
   pressure at the dew point, exactly. */
near('dew point satisfies pws(td) = pw', P.satPressure(ex1.dp), ex1.pw, 1e-9);
near('dew point is around 7.4 C', ex1.dp, 7.43, 0.05);
near('specific enthalpy h', ex1.h, 56.7, 0.5);
near('specific volume v', ex1.v, 0.896, 0.004);
/* The wet bulb we were given must come back out of the solved state. */
near('wet bulb recovered from W', ex1.wb, 20, 0.02);

/* ------------------------------------------------------- round trips */
section('Inverse round trips');

var p = 101.325;
var cases = [
  [35, 60], [25, 50], [13, 90], [5, 80], [45, 20], [-5, 70], [50, 15], [20, 99]
];
cases.forEach(function (c) {
  var t = c[0];
  var rh = c[1];
  var s = P.state(t, 'rh', rh, p);
  ok('state solves at ' + t + ' C / ' + rh + '%', s.ok);
  if (!s.ok) { return; }
  near('  RH round trip at ' + t + '/' + rh, s.rh, rh, 1e-6);
  /* Wet bulb out, then back in, must reproduce the same humidity ratio. */
  var back = P.state(t, 'wb', s.wb, p);
  near('  W via wet bulb at ' + t + '/' + rh, back.W, s.W, 1e-7);
  /* Same for dew point. */
  var backDp = P.state(t, 'dp', s.dp, p);
  near('  W via dew point at ' + t + '/' + rh, backDp.W, s.W, 1e-9);
  /* And enthalpy. */
  var backH = P.state(t, 'h', s.h, p);
  near('  W via enthalpy at ' + t + '/' + rh, backH.W, s.W, 1e-9);
});

/* At saturation all three temperatures coincide. */
section('At saturation the three temperatures meet');
[0, 10, 20, 30, 40].forEach(function (t) {
  var s = P.state(t, 'rh', 100, p);
  near('t = wb at ' + t + ' C saturated', s.wb, t, 0.01);
  near('t = dp at ' + t + ' C saturated', s.dp, t, 0.01);
});

/* ----------------------------------------------- wet bulb, the hard case */
section('Wet bulb where the psychrometer approximation fails');

/* Very dry, very hot — the condition the Sprung formula is worst at, and
   exactly the outdoor design case in the Gulf interior. Checked by the
   defining relation rather than a table: Eq 33 evaluated at the returned
   wet bulb must reproduce the humidity ratio it was derived from. */
[[45, 8], [50, 5], [40, 10], [46, 12]].forEach(function (c) {
  var s = P.state(c[0], 'rh', c[1], p);
  var W = P.humRatioFromWetBulb(c[0], s.wb, p);
  near('Eq 33 closes at ' + c[0] + ' C / ' + c[1] + '%', W, s.W, 1e-7);
});

/* Below freezing the wick ices and Eq 35 takes over. */
var cold = P.state(-10, 'rh', 50, p);
ok('sub-zero state solves', cold.ok);
near('Eq 35 closes at -10 C / 50%', P.humRatioFromWetBulb(-10, cold.wb, p), cold.W, 1e-7);

/* ----------------------------------------------------- altitude effect */
section('Altitude changes the answer, not just the label');

var seaLevel = P.state(35, 'rh', 50, P.pressureAtAltitude(0));
var riyadh = P.state(35, 'rh', 50, P.pressureAtAltitude(612));
ok('same RH holds more moisture at altitude', riyadh.W > seaLevel.W);
near('and by about 7%', riyadh.W / seaLevel.W, 1.075, 0.02);

/* --------------------------------------------------------- properties */
section('Density is the mixture density, not 1/v');

var d = P.state(35, 'rh', 60, p);
var mixtureDensity = P.density(35, d.W, p);
var dryAirOnly = 1 / d.v;
ok('the two differ', Math.abs(mixtureDensity - dryAirOnly) > 0.01);
near('mixture density = (1+W)/v', mixtureDensity, (1 + d.W) / d.v, 1e-12);
near('the gap is about 2%', mixtureDensity / dryAirOnly, 1 + d.W, 1e-12);

/* ------------------------------------------------------------- loads */
section('Loads close: sensible + latent = total');

var s1 = P.state(35, 'rh', 60, p);
var s2 = P.state(13, 'rh', 90, p);
var L = P.loads(s1, s2, 10000 / 3600);
ok('loads computed', !!L);
near('sensible + latent = total', L.sensible + L.latent, L.total, 1e-9);
ok('cooling is a negative total', L.total < 0);
ok('SHR is between 0 and 1 for this coil', L.shr > 0 && L.shr < 1);
/* Mass flow is taken at the entering state, where the flow is measured. */
near('mass flow of dry air = V1/v1', L.massFlowDryAir, (10000 / 3600) / s1.v, 1e-12);

/* A purely sensible process must come out with SHR of exactly one. */
var h1 = P.state(5, 'w', 4, p);
var h2 = P.state(22, 'w', 4, p);
var LH = P.loads(h1, h2, 8000 / 3600);
near('sensible heating has SHR 1', LH.shr, 1, 1e-9);
near('and no latent load', LH.latent, 0, 1e-9);

/* ------------------------------------------------------- ADP and BF */
section('Apparatus dew point and bypass factor');

/* 27/50 to 13/95 is an ordinary comfort cooling duty and does have an ADP. */
var c1 = P.state(27, 'rh', 50, p);
var c2 = P.state(13, 'rh', 95, p);
var adp = P.apparatusDewPoint(c1, c2);
ok('ADP found for a cooling and dehumidifying coil', !!adp);
ok('ADP is below the leaving dry bulb', adp.t < c2.db);
ok('bypass factor is a sensible fraction', adp.bypassFactor > 0 && adp.bypassFactor < 0.4);
/* The ADP sits on the saturation curve, by construction. */
near('ADP lies on the saturation curve', adp.W, P.satHumRatio(adp.t, p), 1e-9);
/* The three points are collinear on the chart. */
var slopeProcess = (c2.W - c1.W) / (c2.db - c1.db);
var slopeToAdp = (adp.W - c1.W) / (adp.t - c1.db);
near('ADP is on the extended process line', slopeToAdp, slopeProcess, 1e-7);

ok('no ADP for a heating process', P.apparatusDewPoint(h1, h2) === null);

/* A very low sensible heat ratio makes the process line steeper than the
   saturation curve, so the two never meet and there is no ADP. That is a real
   answer about the duty, not a solver failure, and it must come back as null
   rather than as a fabricated temperature. */
ok('no ADP when the process line never reaches saturation',
   P.apparatusDewPoint(P.state(35, 'rh', 60, p), P.state(13, 'rh', 90, p)) === null);

/* -------------------------------------------------------------- mixing */
section('Adiabatic mixing — ASHRAE Eq 45/46');

var fresh = P.state(45, 'rh', 25, p);
var ret = P.state(24, 'rh', 50, p);
var mixed = P.mix(fresh, 1, ret, 3);          /* 25% fresh air by volume */
ok('mixed state solves', mixed.ok);
ok('mixed dry bulb sits between the two', mixed.db > ret.db && mixed.db < fresh.db);
ok('mixed humidity ratio sits between the two', mixed.W > ret.W && mixed.W < fresh.W);
/* Enthalpy is what is conserved, so it must be the mass-weighted mean. */
var mA = 1 / fresh.v;
var mB = 3 / ret.v;
near('mixed enthalpy is the mass-weighted mean',
     mixed.h, (mA * fresh.h + mB * ret.h) / (mA + mB), 1e-7);
near('mixed humidity ratio is the mass-weighted mean',
     mixed.W, (mA * fresh.W + mB * ret.W) / (mA + mB), 1e-9);

/* An equal-mass mix of identical states must return that state. */
var same = P.mix(ret, 2, ret, 2);
near('mixing a stream with itself changes nothing', same.db, ret.db, 1e-7);

/* --------------------------------------------------- input validation */
section('Impossible inputs are rejected with a reason, not a shrug');

ok('RH above 100 is rejected', P.state(25, 'rh', 120, p).ok === false);
ok('wet bulb above dry bulb is rejected', P.state(25, 'wb', 30, p).ok === false);
ok('dew point above dry bulb is rejected', P.state(25, 'dp', 30, p).ok === false);
ok('supersaturated humidity ratio is rejected', P.state(20, 'w', 30, p).ok === false);
ok('missing temperature is rejected', P.state(NaN, 'rh', 50, p).ok === false);
ok('the rejection carries a message',
   typeof P.state(20, 'w', 30, p).error === 'string' && P.state(20, 'w', 30, p).error.length > 10);
/* Each rejection should say something different — a single generic message
   for every failure is the thing this replaces. */
var messages = [
  P.state(25, 'rh', 120, p).error,
  P.state(25, 'wb', 30, p).error,
  P.state(20, 'w', 30, p).error,
  P.state(NaN, 'rh', 50, p).error
];
ok('the messages are distinct', new Set(messages).size === messages.length);

/* -------------------------------------------------------- IP conversion */
section('Imperial conversion at the display edge');

near('0 C is 32 F', P.ip.tempToF(0), 32, 1e-9);
near('100 C is 212 F', P.ip.tempToF(100), 212, 1e-9);
/* Enthalpy datums differ, so this is not a plain scale factor. */
near('dry air at 20 C is 16.32 Btu/lb', P.ip.enthalpyToIP(P.enthalpy(20, 0)), 16.32, 0.02);
near('enthalpy round trip', P.ip.enthalpyToSI(P.ip.enthalpyToIP(56.7)), 56.7, 1e-9);
near('1 kW is 3412 Btu/h', P.ip.powerToBtuh(1), 3412.142, 0.001);
near('3.517 kW is one ton', P.ip.powerToTons(3.516853), 1, 1e-6);
near('humidity ratio in grains', P.ip.humRatioToGrains(0.010), 70, 1e-9);

/* ------------------------------------------------------------- report */
console.log('\n' + '-'.repeat(60));
if (fail === 0) {
  console.log(pass + ' checks passed.');
} else {
  console.log(pass + ' passed, ' + fail + ' FAILED:\n');
  failures.forEach(function (f) { console.log('  x ' + f); });
  process.exitCode = 1;
}
