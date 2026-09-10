/* Sound Level & NC Calculator — Thinkneering QuickTools.

   Everything runs in the browser. No network, no storage, no dependencies.

   Ten octave bands are carried, 16 Hz to 8 kHz, because the two lowest are
   needed for a correct RC Mark II rating even though catalogue data almost
   never publishes them. NC is rated over 63 Hz to 8 kHz per ANSI/ASA S12.2;
   RC Mark II is rated over 16 Hz to 4 kHz per ASHRAE Handbook — Applications,
   Chapter 49.

   Pipeline per path:
     entered bands
       -> strip A-weighting if the data sheet published it that way
       -> convert Lp to Lw if the user entered pressure
       -> add safety factor and environmental adjustment
       -> subtract element insertion losses
       -> log-add regenerated noise
     paths are log-summed, then propagated to the receiver. */
(function () {
  'use strict';

  // ------------------------------------------------------------ constants

  var BANDS = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
  var LABELS = ['16', '31.5', '63', '125', '250', '500', '1k', '2k', '4k', '8k'];

  /* Octave band edges, ANSI S1.11 / IEC 61260 base-10 system. Reference only. */
  var EDGES = ['11–22', '22–45', '45–90', '90–180', '180–355', '355–710',
    '710–1400', '1400–2800', '2800–5600', '5600–11200'];

  /* A-weighting, IEC 61672-1. */
  var A_WT = [-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1];

  /* C-weighting, for reference in the tables. */
  var C_WT = [-8.5, -3.0, -0.8, -0.2, 0, 0, 0, -0.2, -0.8, -3.0];

  /* Atmospheric absorption, dB per km, ISO 9613-2 at 20 °C and 70% RH. */
  var AIR = [0.02, 0.05, 0.1, 0.4, 1.0, 1.9, 3.7, 9.7, 32.8, 117];

  /* NC curves, 63 Hz to 8 kHz (band indices 2 to 9). ANSI/ASA S12.2. */
  var NC_LO = 2, NC_HI = 9;
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
  var NC_KEYS = Object.keys(NC).map(Number).sort(function (a, b) { return a - b; });

  /* Just-noticeable and significant level differences, by band region.
     Reference material for the guidance panel. */
  var JND = [
    { band: '16 – 63 Hz', jnd: '1 dB', sig: '3 dB', dbl: '6 dB' },
    { band: '125 Hz', jnd: '1.5 dB', sig: '4 dB', dbl: '8 dB' },
    { band: '250 Hz and above', jnd: '2 dB', sig: '5 dB', dbl: '10 dB' }
  ];

  /* Maximum duct velocities against a design criterion, ASHRAE Handbook —
     Applications. Given in fpm as published; m/s is derived. */
  var DUCT_V = [
    { nc: 50, v: [2000, 2500, 2500, 2800, 3000] },
    { nc: 45, v: [1600, 2000, 2000, 2400, 2600] },
    { nc: 40, v: [1300, 1700, 1700, 2200, 2300] },
    { nc: 35, v: [1000, 1300, 1300, 1700, 1900] },
    { nc: 30, v: [800, 1000, 1000, 1200, 1400] },
    { nc: 25, v: [600, 800, 800, 1000, 1200] },
    { nc: 20, v: [null, 500, 500, 600, 600] }
  ];
  var DUCT_V_COLS = ['Square, no vanes', 'Radius, no vanes', 'Square, short vanes',
    'Square, long vanes', 'Radius with vanes'];

  /* Sound absorption coefficients by room finish. Mid-range published values
     for the construction described; the room term is not sensitive to small
     changes in alpha. The two lowest bands are estimated down from 63 Hz,
     where published coefficients usually stop. */
  var ROOMS = {
    'hotel-guest': { label: 'Hotel guest room — carpet, curtains, bed, soft furnishing', a: [0.07, 0.08, 0.10, 0.14, 0.20, 0.24, 0.28, 0.32, 0.35, 0.35] },
    'hotel-corridor': { label: 'Hotel corridor — carpet, hard walls', a: [0.05, 0.06, 0.08, 0.11, 0.16, 0.20, 0.24, 0.26, 0.28, 0.28] },
    'office-ac': { label: 'Office — acoustic ceiling and carpet', a: [0.08, 0.10, 0.12, 0.18, 0.28, 0.38, 0.45, 0.48, 0.48, 0.48] },
    meeting: { label: 'Meeting room — acoustically treated', a: [0.10, 0.12, 0.15, 0.22, 0.32, 0.42, 0.50, 0.52, 0.52, 0.50] },
    ward: { label: 'Hospital ward or patient room', a: [0.05, 0.06, 0.08, 0.12, 0.18, 0.22, 0.26, 0.30, 0.32, 0.32] },
    lobby: { label: 'Lobby or retail — mixed hard and soft', a: [0.05, 0.06, 0.08, 0.10, 0.14, 0.18, 0.22, 0.25, 0.28, 0.28] },
    workshop: { label: 'Workshop or warehouse — mostly hard', a: [0.03, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.10, 0.10, 0.10] },
    plant: { label: 'Plant room — bare concrete and blockwork', a: [0.02, 0.02, 0.02, 0.02, 0.03, 0.03, 0.04, 0.05, 0.05, 0.05] }
  };

  /* Design criteria. ASHRAE Handbook — Applications publishes ranges; the
     values here sit at the point brand standards and specifications commonly
     land. The project specification always wins over any default here. */
  var CRITERIA = [
    { v: 25, label: 'Hotel guest room, luxury brand standard — NC 25' },
    { v: 30, label: 'Hotel guest room or suite, general — NC 30' },
    { v: 30, label: 'Private office — NC 30' },
    { v: 30, label: 'Conference room — NC 30' },
    { v: 30, label: 'Hospital patient room — NC 30' },
    { v: 30, label: 'Classroom or lecture room — NC 30' },
    { v: 30, label: 'Apartment or private residence — NC 30' },
    { v: 35, label: 'Hotel meeting or banquet room — NC 35' },
    { v: 35, label: 'Operating theatre — NC 35' },
    { v: 35, label: 'Hospital ward — NC 35' },
    { v: 40, label: 'Open plan office — NC 40' },
    { v: 40, label: 'Hotel corridor or lobby — NC 40' },
    { v: 40, label: 'Laboratory — NC 40' },
    { v: 45, label: 'Restaurant — NC 45' },
    { v: 45, label: 'Kitchen or back of house — NC 45' },
    { v: 55, label: 'Workshop or plant room — NC 55' }
  ];

  /* Path element library. INDICATIVE typical insertion losses for early
     sizing. Manufacturer tested data must replace these in a submittal, and
     the interface says so. Below 63 Hz no attenuation is credited: published
     insertion loss data rarely extends there, and assuming some would be the
     optimistic error rather than the safe one.

     Regenerated noise is deliberately not modelled. It depends on velocity
     and geometry this tool does not ask for, so the user enters it from their
     duct acoustics software instead of receiving a guess. */
  var ELEMENTS = [
    { id: 'flex15', group: 'Flexible duct', label: 'Lined flexible duct, 1.5 m, Ø200', count: true, il: [0, 0, 3, 5, 6, 15, 20, 15, 12, 12] },
    { id: 'flex07', group: 'Flexible duct', label: 'Lined flexible duct, 0.7 m, Ø150', count: true, il: [0, 0, 2, 4, 5, 12, 16, 17, 10, 10] },

    { id: 'ductlined', group: 'Ductwork', label: 'Lined rectangular duct, per 1 m, 25 mm lining', count: true, il: [0, 0, 0.5, 1, 2.5, 5, 8, 7, 5, 4] },
    { id: 'ductbare', group: 'Ductwork', label: 'Bare sheet metal duct, per 1 m', count: true, il: [0, 0, 0.6, 0.6, 0.45, 0.3, 0.3, 0.3, 0.3, 0.3] },
    { id: 'elbowlined', group: 'Ductwork', label: '90° elbow, lined', count: true, il: [0, 0, 0, 1, 5, 8, 4, 3, 3, 3] },
    { id: 'elbowbare', group: 'Ductwork', label: '90° elbow, unlined', count: true, il: [0, 0, 0, 0, 1, 2, 3, 3, 3, 3] },

    { id: 'plenum', group: 'Plenums and silencers', label: 'Lined plenum or return box', count: false, il: [0, 0, 1, 3, 6, 10, 13, 13, 11, 9] },
    { id: 'sil900', group: 'Plenums and silencers', label: 'Splitter silencer, 900 mm', count: false, il: [0, 0, 5, 9, 16, 25, 32, 30, 20, 14] },
    { id: 'sil1200', group: 'Plenums and silencers', label: 'Splitter silencer, 1200 mm', count: false, il: [0, 0, 7, 12, 22, 34, 42, 38, 26, 18] },

    { id: 'split2', group: 'Branch power split', label: 'Split to 2 equal branches', count: false, il: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3] },
    { id: 'split3', group: 'Branch power split', label: 'Split to 3 equal branches', count: false, il: [4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8] },
    { id: 'split4', group: 'Branch power split', label: 'Split to 4 equal branches', count: false, il: [6, 6, 6, 6, 6, 6, 6, 6, 6, 6] },

    { id: 'end200', group: 'Termination', label: 'End reflection, Ø200 flush termination', count: false, il: [0, 0, 12, 8, 4, 2, 1, 0, 0, 0] },
    { id: 'end300', group: 'Termination', label: 'End reflection, Ø300 flush termination', count: false, il: [0, 0, 9, 5, 2, 1, 0, 0, 0, 0] },

    { id: 'ceiltile', group: 'Radiated path only', label: 'Mineral fibre lay-in ceiling', count: false, il: [0, 0, 12, 13, 15, 17, 18, 20, 22, 22] },
    { id: 'ceilgyp', group: 'Radiated path only', label: '12.5 mm gypsum ceiling', count: false, il: [0, 0, 16, 18, 21, 25, 28, 32, 35, 35] }
  ];

  /* Worked examples. Only measured or published data supplied by the user is
     included, so the 16 and 31.5 Hz bands are left empty rather than invented.
     These sheets publish A-weighted bands, which the loader accounts for. */
  var EXAMPLES = {
    fww200: {
      weighting: 'a', note: 'FWW200VA at medium speed. Bands are A-weighted as published — the loader has set the weighting selector to match.',
      a: { name: 'Inlet + casing radiated', type: 'nonducted', bands: ['', '', 23.4, 35.9, 45.2, 51.3, 49.8, 46.1, 39.1, 30.2] },
      b: { name: 'Discharge duct', type: 'ducted', bands: ['', '', 23.6, 26.1, 32.4, 41.7, 47.5, 42.8, 38.0, 31.5] }
    },
    fww600: {
      weighting: 'a', note: 'FWW600VA at medium speed. Bands are A-weighted as published — the loader has set the weighting selector to match.',
      a: { name: 'Inlet + casing radiated', type: 'nonducted', bands: ['', '', 26.4, 41.7, 49.5, 55.3, 55.8, 51.4, 45.2, 37.9] },
      b: { name: 'Discharge duct', type: 'ducted', bands: ['', '', 21.9, 35.8, 42.2, 48.0, 54.3, 50.0, 45.8, 41.2] }
    },
    fww1000: {
      weighting: 'a', note: 'FWW1000VA at medium speed. Bands are A-weighted as published — the loader has set the weighting selector to match.',
      a: { name: 'Inlet + casing radiated', type: 'nonducted', bands: ['', '', 32.1, 48.2, 55.8, 60.8, 61.1, 58.9, 53.4, 45.4] },
      b: { name: 'Discharge duct', type: 'ducted', bands: ['', '', 29.4, 40.2, 47.0, 53.5, 59.2, 54.4, 51.5, 47.2] }
    },
    ashrae: {
      weighting: 'lin', mode: 'direct', single: true,
      note: 'The worked example from ASHRAE Handbook — Applications, Chapter 49, entered as a room spectrum so you can check the RC Mark II result against the published answer of RC 35(LF), QAI 7.2.',
      a: { name: 'Measured room spectrum', type: 'nonducted', bands: [64, 65, 64, 57, 47, 40, 35, 30, 23, ''] }
    }
  };

  /* Equipment presets. */
  var EQUIP = {
    fcu: {
      mode: 'indoor', room: 'hotel-guest', crit: 1, twoPaths: true,
      a: { name: 'Inlet + casing radiated', type: 'nonducted' },
      b: { name: 'Discharge duct', type: 'ducted' },
      help: 'Enter both paths from the data sheet. The inlet and radiated path usually governs, because the return grille often sits directly below the unit with almost nothing in between.'
    },
    'ahu-duct': {
      mode: 'indoor', room: 'office-ac', crit: 10, twoPaths: true,
      a: { name: 'Supply duct discharge', type: 'ducted' },
      b: { name: 'Return duct', type: 'ducted' },
      help: 'Both duct paths reach the served space. Build the element chain for each separately — they rarely have the same attenuation.'
    },
    'ahu-plant': {
      mode: 'indoor', room: 'plant', crit: 15, twoPaths: false,
      a: { name: 'Casing breakout', type: 'nonducted' },
      b: { name: 'Second path', type: 'ducted' },
      help: 'Casing breakout into the plant room. There is no duct to attenuate it, so room finish and distance are your only levers.'
    },
    chiller: {
      mode: 'outdoor', room: 'plant', crit: 15, twoPaths: false,
      a: { name: 'Chiller sound power', type: 'nonducted' },
      b: { name: 'Second unit', type: 'nonducted' },
      help: 'Outdoors there is no room to help you. Distance, directivity and a barrier are the whole calculation. Add a second path for another unit running at the same time.'
    },
    other: {
      mode: 'indoor', room: 'office-ac', crit: 10, twoPaths: false,
      a: { name: 'Path A', type: 'ducted' },
      b: { name: 'Path B', type: 'ducted' },
      help: ''
    }
  };

  // -------------------------------------------------------------- helpers

  function logSum(levels) {
    var s = 0, i;
    for (i = 0; i < levels.length; i++) {
      if (isFinite(levels[i])) s += Math.pow(10, levels[i] / 10);
    }
    return s > 0 ? 10 * Math.log10(s) : -Infinity;
  }

  function energyAvg(levels) {
    var s = 0, n = 0, i;
    for (i = 0; i < levels.length; i++) {
      if (isFinite(levels[i])) { s += Math.pow(10, levels[i] / 10); n++; }
    }
    return n ? 10 * Math.log10(s / n) : NaN;
  }

  function dBA(bands) {
    var w = [], i;
    for (i = 0; i < BANDS.length; i++) {
      if (isFinite(bands[i])) w.push(bands[i] + A_WT[i]);
    }
    return w.length ? logSum(w) : NaN;
  }

  function r1(n) { return isFinite(n) ? Math.round(n * 10) / 10 : null; }
  function fmt(n) { var v = r1(n); return v === null ? '—' : String(v); }

  /* NC rating by tangency, interpolated between the tabulated curves so the
     answer reads NC 33 rather than being rounded up to the next multiple
     of five. Returns the governing band, which is the part that matters. */
  function ncRating(lp) {
    var worst = -Infinity, gov = -1, i;
    for (i = NC_LO; i <= NC_HI; i++) {
      if (!isFinite(lp[i])) continue;
      var col = i - NC_LO, v = lp[i], nc = null, k;
      for (k = 0; k < NC_KEYS.length - 1; k++) {
        var lo = NC[NC_KEYS[k]][col], hi = NC[NC_KEYS[k + 1]][col];
        if (v >= lo && v <= hi) {
          nc = NC_KEYS[k] + (v - lo) / (hi - lo) * (NC_KEYS[k + 1] - NC_KEYS[k]);
          break;
        }
      }
      if (nc === null) {
        var first = NC[NC_KEYS[0]][col], n = NC_KEYS.length,
          last = NC[NC_KEYS[n - 1]][col];
        if (v < first) {
          nc = NC_KEYS[0] + (v - first) /
            ((NC[NC_KEYS[1]][col] - first) / (NC_KEYS[1] - NC_KEYS[0]));
        } else {
          nc = NC_KEYS[n - 1] + (v - last) /
            ((last - NC[NC_KEYS[n - 2]][col]) / (NC_KEYS[n - 1] - NC_KEYS[n - 2]));
        }
      }
      if (nc > worst) { worst = nc; gov = i; }
    }
    return gov < 0 ? null : { value: worst, band: gov };
  }

  /* RC Mark II per ASHRAE Handbook — Applications, Chapter 49.

     The level is the arithmetic mean of the 500, 1000 and 2000 Hz bands. The
     reference contour is a line through that level at 1 kHz falling 5 dB per
     octave, with the 16 Hz point held level with 31.5 Hz rather than
     extrapolated. Spectral deviation factors are the energy average of
     (level − contour) across each of the three regions, and the Quality
     Assessment Index is the range between the highest and lowest factor.

     Verified against the handbook's own worked example, which returns
     RC 35(LF) with a QAI of 7.2. */
  function rcMarkII(lp) {
    if (!isFinite(lp[5]) || !isFinite(lp[6]) || !isFinite(lp[7])) return null;
    var level = (lp[5] + lp[6] + lp[7]) / 3;
    var contour = [level + 25, level + 25, level + 20, level + 15, level + 10,
      level + 5, level, level - 5, level - 10];

    var dev = [], i;
    for (i = 0; i <= 8; i++) dev.push(isFinite(lp[i]) ? lp[i] - contour[i] : NaN);

    var LF = energyAvg(dev.slice(0, 3));
    var MF = energyAvg(dev.slice(3, 6));
    var HF = energyAvg(dev.slice(6, 9));

    /* The handbook rounds the factors before taking the range. */
    var f = [r1(LF), r1(MF), r1(HF)].filter(function (v) { return v !== null; });
    if (!f.length) return null;
    var qai = Math.max.apply(null, f) - Math.min.apply(null, f);

    var names = ['LF', 'MF', 'HF'], vals = [LF, MF, HF];
    var top = 0;
    for (i = 1; i < 3; i++) {
      if (isFinite(vals[i]) && (!isFinite(vals[top]) || vals[i] > vals[top])) top = i;
    }

    var descriptor = 'N', word = 'Neutral';
    if (qai > 5 && vals[top] > 0) {
      descriptor = names[top];
      word = top === 0 ? 'Rumbly' : (top === 1 ? 'Roaring' : 'Hissy');
    }

    var verdict = qai <= 5 ? 'Acceptable' : (qai <= 10 ? 'Marginal' : 'Objectionable');
    var partial = !isFinite(lp[0]) || !isFinite(lp[1]);

    return {
      level: level, contour: contour, dev: dev, LF: LF, MF: MF, HF: HF,
      qai: qai, descriptor: descriptor, word: word, verdict: verdict,
      partial: partial
    };
  }

  /* Maekawa barrier attenuation from the Fresnel number, capped at the
     24 dB that a thin screen achieves in practice. */
  function barrierIL(delta, f) {
    if (!delta || delta <= 0) return 0;
    var N = 2 * delta * f / 343;
    return Math.min(Math.max(10 * Math.log10(3 + 20 * N), 0), 24);
  }

  // ---------------------------------------------------------------- state

  function blankPath(name, type) {
    return {
      name: name, type: type,
      bands: BANDS.map(function () { return ''; }),
      regen: BANDS.map(function () { return ''; }),
      eaf: BANDS.map(function () { return 0; }),
      safety: 0, elements: {}
    };
  }

  var state = {
    showB: false,
    paths: { a: blankPath('Path A', 'ducted'), b: blankPath('Path B', 'ducted') }
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return window.TN ? TN.esc(s) : String(s); }

  // ------------------------------------------------------- static selects

  function fillSelects() {
    var absorb = $('absorb');
    Object.keys(ROOMS).forEach(function (k) {
      absorb.insertAdjacentHTML('beforeend',
        '<option value="' + k + '">' + esc(ROOMS[k].label) + '</option>');
    });
    absorb.value = 'hotel-guest';

    var crit = $('nc-target');
    CRITERIA.forEach(function (c, i) {
      crit.insertAdjacentHTML('beforeend',
        '<option value="' + i + '">' + esc(c.label) + '</option>');
    });
    crit.value = '1';
  }

  // ------------------------------------------------------------- path UI

  function bandRow(key, role, prefix, values, step, placeholder) {
    var h = '<div class="table-wrap snd-bandwrap"><div class="snd-bands">';
    BANDS.forEach(function (b, i) {
      var id = 'p' + key + '-' + prefix + i;
      h += '<div class="snd-band' + (i < 2 ? ' snd-band--low' : '') + '">' +
        '<label for="' + id + '">' + LABELS[i] + '</label>' +
        '<input type="number" id="' + id + '" data-path="' + key + '" data-role="' + role +
        '" data-i="' + i + '" step="' + step + '" inputmode="decimal" value="' +
        esc(values[i]) + '"' + (placeholder ? ' placeholder="' + placeholder + '"' : '') + '>' +
        '</div>';
    });
    return h + '</div></div>';
  }

  function pathMarkup(key) {
    var p = state.paths[key];
    var idp = 'p' + key;
    var h = '';

    h += '<div class="snd-path" data-path="' + key + '"' +
      (key === 'b' && !state.showB ? ' hidden' : '') + '>';

    h += '<div class="snd-path__head">' +
      '<h3 id="' + idp + '-title">' + esc(p.name) + '</h3>' +
      '<span class="snd-path__sum num" id="' + idp + '-sum"></span></div>';

    h += '<div class="field-row">';
    h += '<div class="field"><label for="' + idp + '-type">Path type</label>' +
      '<select id="' + idp + '-type" data-path="' + key + '" data-role="type">' +
      '<option value="ducted"' + (p.type === 'ducted' ? ' selected' : '') +
      '>Ducted — travels through ductwork</option>' +
      '<option value="nonducted"' + (p.type === 'nonducted' ? ' selected' : '') +
      '>Non-ducted — straight into the room</option></select>' +
      '<p class="hint" id="' + idp + '-typehelp"></p></div>';

    h += '<div class="field"><label for="' + idp + '-safety">Safety factor, dB</label>' +
      '<input type="number" id="' + idp + '-safety" data-path="' + key +
      '" data-role="safety" value="' + p.safety + '" min="0" max="10" step="1" inputmode="decimal">' +
      '<p class="hint">Allowance for build tolerance and data uncertainty. 3 dB is common on submittals.</p></div>';
    h += '</div>';

    h += '<div class="snd-blk"><p class="label" id="' + idp + '-bl">Octave band level, dB</p>' +
      bandRow(key, 'band', 'b', p.bands, '0.1', '—') +
      '<p class="hint">16 and 31.5 Hz are optional. Catalogue data rarely publishes them, but RC Mark II needs them for a complete rating.</p></div>';

    h += '<details class="snd-more"><summary>Regenerated noise and environmental adjustment</summary>' +
      '<div class="snd-more__body">' +
      '<p>Dampers, takeoffs and sharp transitions <em>add</em> noise downstream of everything installed to remove it. This tool does not guess those figures. Enter the regenerated sound power from your duct acoustics software or damper data and it is log-added at the terminal.</p>' +
      bandRow(key, 'regen', 'r', p.regen, '0.1', '—') +
      '<p>Environmental adjustment, applied to the source before any attenuation. Corrects published fan data for the difference between the test rig and the installed condition. Usually small and negative at low frequency.</p>' +
      bandRow(key, 'eaf', 'e', p.eaf, '1', '0') +
      '</div></details>';

    h += '<details class="snd-more" id="' + idp + '-chain"><summary>Path elements ' +
      '<span class="snd-path__sum num" id="' + idp + '-atten"></span></summary>' +
      '<div class="snd-more__body" id="' + idp + '-chainbody"></div></details>';

    return h + '</div>';
  }

  function elementMarkup(key) {
    var p = state.paths[key];
    var idp = 'p' + key;

    if (p.type === 'nonducted') {
      return '<div class="notice notice--warning">' +
        '<p><strong>No path elements apply to a non-ducted unit.</strong> There is no ductwork, no plenum and no flexible connection between the fan and the room, so there is nothing to insert loss into. The sound power goes straight to the room effect.</p>' +
        '<p>This is not a gap in the calculation — it is the calculation. It also means unit size and fan speed are your only remaining levers. If the result fails, oversize the unit so it runs slower, or change to a ducted arrangement.</p>' +
        '<p>One caution: manufacturers often publish sound <em>pressure</em> at a stated distance in a stated test room for cassettes and wall-mounted units, not sound power. Check the footnote on your table and set the data type above to match, or the room gets counted twice.</p></div>';
    }

    var h = '<p class="hint">Indicative typical insertion losses for early sizing. Replace with tested manufacturer data before issuing a submittal. No attenuation is credited below 63 Hz, because published data rarely extends there.</p>' +
      '<div class="snd-atten">';
    var lastGroup = '';
    ELEMENTS.forEach(function (el) {
      if (el.group !== lastGroup) {
        h += '<p class="snd-atten__group">' + esc(el.group) + '</p>';
        lastGroup = el.group;
      }
      var sel = p.elements[el.id];
      var on = !!sel;
      h += '<div class="snd-atten__row">' +
        '<input type="checkbox" id="' + idp + '-el-' + el.id + '" data-path="' + key +
        '" data-role="el" data-el="' + el.id + '"' + (on ? ' checked' : '') + '>' +
        '<label for="' + idp + '-el-' + el.id + '">' + esc(el.label) + '</label>';
      if (el.count) {
        h += '<input type="number" aria-label="Quantity of ' + esc(el.label) +
          '" data-path="' + key + '" data-role="elcount" data-el="' + el.id +
          '" value="' + (sel || 1) + '" min="1" max="50" step="1"' +
          (on ? '' : ' disabled') + '>';
      } else {
        h += '<span aria-hidden="true"></span>';
      }
      h += '</div>';
    });
    return h + '</div>';
  }

  function renderPaths() {
    $('paths').innerHTML = pathMarkup('a') + pathMarkup('b');
    ['a', 'b'].forEach(function (k) {
      $('p' + k + '-chainbody').innerHTML = elementMarkup(k);
      typeHelp(k);
    });
  }

  function typeHelp(key) {
    var el = $('p' + key + '-typehelp');
    if (!el) return;
    el.textContent = state.paths[key].type === 'ducted'
      ? 'Duct, plenum, flex and end reflection losses become available below.'
      : 'No attenuation is available on this path.';
  }

  // ----------------------------------------------------------- read form

  function readForm() {
    ['a', 'b'].forEach(function (k) {
      var p = state.paths[k], i;
      for (i = 0; i < BANDS.length; i++) {
        var b = $('p' + k + '-b' + i), r = $('p' + k + '-r' + i), e = $('p' + k + '-e' + i);
        if (b) p.bands[i] = b.value;
        if (r) p.regen[i] = r.value;
        if (e) p.eaf[i] = parseFloat(e.value) || 0;
      }
      var s = $('p' + k + '-safety');
      if (s) p.safety = parseFloat(s.value) || 0;
    });
  }

  // ---------------------------------------------------------- calculation

  function pathToLw(key) {
    var p = state.paths[key];
    var weighting = $('weighting').value;
    var quantity = $('quantity').value;
    var lpDist = parseFloat($('lp-dist').value) || 1;
    var out = [], atten = [], used = false, i;

    for (i = 0; i < BANDS.length; i++) {
      var raw = parseFloat(p.bands[i]);
      if (!isFinite(raw)) { out.push(NaN); atten.push(0); continue; }
      used = true;
      var v = raw;

      if (weighting === 'a') v = v - A_WT[i];
      if (quantity === 'lp' && $('mode').value !== 'direct') {
        v = v - 10 * Math.log10(2 / (4 * Math.PI * lpDist * lpDist));
      }
      v = v + p.safety + p.eaf[i];

      var a = 0;
      if (p.type === 'ducted') {
        Object.keys(p.elements).forEach(function (id) {
          for (var n = 0; n < ELEMENTS.length; n++) {
            if (ELEMENTS[n].id === id) {
              a += ELEMENTS[n].il[i] * (ELEMENTS[n].count ? p.elements[id] : 1);
              return;
            }
          }
        });
      }
      atten.push(a);
      v = v - a;

      var rg = parseFloat(p.regen[i]);
      if (isFinite(rg)) v = logSum([v, rg]);
      out.push(v);
    }
    return { lw: out, atten: atten, used: used };
  }

  function roomTerm(i) {
    var L = parseFloat($('rl').value) || 1;
    var W = parseFloat($('rw').value) || 1;
    var H = parseFloat($('rh').value) || 1;
    var r = parseFloat($('rdist').value) || 1;
    var Q = parseFloat($('q-in').value) || 2;
    var alpha = ROOMS[$('absorb').value].a[i];
    var S = 2 * (L * W + L * H + W * H);
    var R = S * alpha / (1 - alpha);
    return 10 * Math.log10(Q / (4 * Math.PI * r * r) + 4 / R);
  }

  function outdoorTerm(i) {
    var r = parseFloat($('odist').value) || 1;
    var Q = parseFloat($('q-out').value) || 2;
    var d = parseFloat($('barrier').value) || 0;
    return 10 * Math.log10(Q / (4 * Math.PI * r * r))
      - AIR[i] * r / 1000
      - barrierIL(d, BANDS[i]);
  }

  function compute() {
    readForm();
    var mode = $('mode').value;
    var direct = mode === 'direct';
    var indoor = mode === 'indoor';
    /* NC and RC are room ratings, so they apply to a directly entered room
       spectrum just as they do to a propagated one. */
    var rate = direct || indoor;
    var A = pathToLw('a');
    var B = state.showB ? pathToLw('b')
      : { lw: BANDS.map(function () { return NaN; }), atten: BANDS.map(function () { return 0; }), used: false };

    var lwTotal = [], lp = [], term = [], i;
    for (i = 0; i < BANDS.length; i++) {
      var t = (isFinite(A.lw[i]) || isFinite(B.lw[i])) ? logSum([A.lw[i], B.lw[i]]) : NaN;
      lwTotal.push(t);
      var k = direct ? 0 : (indoor ? roomTerm(i) : outdoorTerm(i));
      term.push(k);
      lp.push(isFinite(t) ? t + k : NaN);
    }

    return {
      indoor: rate, direct: direct, hasData: A.used || B.used, A: A, B: B,
      lwTotal: lwTotal, term: term, lp: lp,
      dba: dBA(lp), nc: ncRating(lp), rc: rcMarkII(lp)
    };
  }

  // ------------------------------------------------------------ rendering

  function stat(label, value) {
    return '<div class="stat"><div class="stat__value">' + esc(value) +
      '</div><div class="stat__label">' + esc(label) + '</div></div>';
  }

  function render() {
    var res = compute();

    ['a', 'b'].forEach(function (k) {
      var r = k === 'a' ? res.A : res.B;
      var sum = $('p' + k + '-sum'), at = $('p' + k + '-atten');
      if (sum) sum.textContent = r.used ? fmt(dBA(r.lw)) + ' dB(A) at terminal' : '';
      if (at) {
        at.textContent = state.paths[k].type === 'ducted'
          ? '−' + fmt(r.atten[6]) + ' dB at 1 kHz' : 'not applicable';
      }
    });

    if (!res.hasData) {
      $('stats').innerHTML = '';
      $('verdict').innerHTML = '<div class="empty">Enter octave band levels above, ' +
        'or load a worked example, and the result appears here.</div>';
      $('chart').innerHTML = '';
      $('legend').innerHTML = '';
      $('table').innerHTML = '';
      $('ductv').innerHTML = '';
      return;
    }

    var s = '';
    s += stat(res.direct ? 'As entered' : (res.indoor ? 'In the room' : 'At the receiver'),
      fmt(res.dba) + ' dB(A)');
    if (res.indoor) {
      if (res.nc) s += stat('Governed by ' + LABELS[res.nc.band] + ' Hz', 'NC ' + Math.round(res.nc.value));
      if (res.rc) s += stat(res.rc.word + ', QAI ' + fmt(res.rc.qai), 'RC ' + Math.round(res.rc.level) + '(' + res.rc.descriptor + ')');
      var target = CRITERIA[+$('nc-target').value].v;
      if (res.nc) {
        s += stat('Against NC ' + target,
          (res.nc.value <= target ? '−' : '+') + fmt(Math.abs(res.nc.value - target)) + ' dB');
      }
    } else {
      var lim = parseFloat($('dba-target').value) || 45;
      s += stat('Limit entered', lim + ' dB(A)');
      s += stat(res.dba <= lim ? 'Within limit' : 'Over limit',
        (res.dba <= lim ? '−' : '+') + fmt(Math.abs(res.dba - lim)) + ' dB');
    }
    $('stats').innerHTML = s;

    renderVerdict(res);
    renderChart(res);
    renderTable(res);
    renderDuctV();
  }

  function renderVerdict(res) {
    var cls, title, body = '';

    if (res.indoor && res.nc) {
      var target = CRITERIA[+$('nc-target').value].v;
      var over = res.nc.value - target;
      if (over <= 0) { cls = 'success'; title = 'Meets NC ' + target; }
      else if (over <= 2) { cls = 'warning'; title = 'Marginal — ' + fmt(over) + ' dB over NC ' + target; }
      else { cls = 'danger'; title = 'Exceeds NC ' + target + ' by ' + fmt(over) + ' dB'; }

      var b = res.nc.band;
      body += '<p>The ' + LABELS[b] + ' Hz band is governing at ' + fmt(res.lp[b]) +
        ' dB, against ' + NC[target][b - NC_LO] + ' dB on the NC ' + target +
        ' curve. Bringing any other band down changes nothing until this one moves.</p>';

      if (over > 0) {
        if (b <= 3) {
          body += '<p>Low frequency is the hard case. Lined duct and flexible connections barely touch 63 and 125 Hz. The realistic options are a larger unit running slower, a longer lined plenum, or added mass on the ceiling or casing.</p>';
        } else if (b >= 7) {
          body += '<p>High frequency responds well to lining. A metre or two of lined flexible duct usually takes this out, provided nothing downstream of it regenerates noise.</p>';
        } else {
          body += '<p>Mid frequency is where silencers and lined plenums earn their length. Check whether a damper or takeoff close to the terminal is regenerating noise past your attenuation.</p>';
        }
      }

      if (res.rc) {
        if (res.rc.descriptor !== 'N') {
          body += '<p>RC Mark II rates this spectrum ' + res.rc.word.toLowerCase() +
            ' — RC ' + Math.round(res.rc.level) + '(' + res.rc.descriptor +
            '), quality assessment index ' + fmt(res.rc.qai) + ' dB, which ASHRAE describes as ' +
            res.rc.verdict.toLowerCase() + '. A spectrum can pass its NC number and still draw complaints on character alone, so treat the letter as seriously as the number.</p>';
        }
        if (res.rc.partial) {
          body += '<p class="hint">The RC rating above is computed without the 16 and 31.5 Hz bands, which were left blank. Rumble is judged mostly on those two, so the letter is provisional until you have them.</p>';
        }
      }
    } else if (res.indoor) {
      cls = 'warning';
      title = 'Not enough bands to rate';
      body = '<p>NC needs levels from 63 Hz to 8 kHz. Fill the missing bands to get a rating.</p>';
    } else {
      var lim = parseFloat($('dba-target').value) || 45;
      var d = res.dba - lim;
      if (d <= 0) { cls = 'success'; title = 'Within ' + lim + ' dB(A) at the receiver'; }
      else if (d <= 2) { cls = 'warning'; title = 'Marginal — ' + fmt(d) + ' dB(A) over'; }
      else { cls = 'danger'; title = 'Exceeds the limit by ' + fmt(d) + ' dB(A)'; }
      body += '<p>Doubling the distance buys 6 dB. A barrier that fully blocks line of sight buys 10 to 15 dB in practice. Discharge attenuators and low-noise fan options are the other levers.</p>';
      body += '<p>Environmental limits usually apply at night, often with a penalty for tonal or intermittent character. Confirm the assessment period and any character correction before relying on a small margin.</p>';
    }

    $('verdict').innerHTML = '<div class="notice notice--' + cls + ' snd-verdict">' +
      '<p class="snd-verdict__title">' + esc(title) + '</p>' + body + '</div>';
  }

  /* The chart is styled entirely from styles.css. SVG presentation attributes
     cannot resolve var(), so colours have to arrive via classes if the chart
     is to follow both themes. */
  function renderChart(res) {
    if (!res.indoor) {
      $('chart').innerHTML = '<div class="empty">The NC chart applies to rooms. ' +
        'In outdoor mode the result is judged on the overall dB(A) figure.</div>';
      $('legend').innerHTML = '';
      return;
    }

    var W = 760, H = 430, ml = 46, mr = 42, mt = 14, mb = 46;
    var pw = W - ml - mr, ph = H - mt - mb, yMax = 90;
    var n = NC_HI - NC_LO;

    function x(col) { return ml + (pw * col) / n; }
    function y(v) { return mt + ph * (1 - Math.min(Math.max(v, 0), yMax) / yMax); }
    function poly(arr) {
      return arr.map(function (v, i) { return x(i) + ',' + y(v); }).join(' ');
    }

    var target = CRITERIA[+$('nc-target').value].v;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" class="snd-svg">';

    for (var g = 0; g <= yMax; g += 10) {
      svg += '<line class="snd-grid" x1="' + ml + '" y1="' + y(g) + '" x2="' + (W - mr) + '" y2="' + y(g) + '"/>';
      svg += '<text class="snd-axis" x="' + (ml - 8) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + g + '</text>';
    }
    for (var c = 0; c <= n; c++) {
      svg += '<text class="snd-axis" x="' + x(c) + '" y="' + (H - mb + 20) + '" text-anchor="middle">' + LABELS[c + NC_LO] + '</text>';
    }
    svg += '<text class="snd-axis" x="' + (ml + pw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">Octave band centre frequency, Hz</text>';
    svg += '<text class="snd-axis" x="14" y="' + (mt + ph / 2) + '" text-anchor="middle" transform="rotate(-90 14 ' + (mt + ph / 2) + ')">Sound pressure level, dB</text>';

    NC_KEYS.forEach(function (k) {
      if (k === target) return;
      svg += '<polyline class="snd-nc" points="' + poly(NC[k]) + '"/>';
      svg += '<text class="snd-nc-lbl" x="' + (W - mr + 5) + '" y="' + (y(NC[k][n]) + 4) + '">' + k + '</text>';
    });

    svg += '<polyline class="snd-target" points="' + poly(NC[target]) + '"/>';
    svg += '<text class="snd-target-lbl" x="' + (W - mr + 5) + '" y="' + (y(NC[target][n]) + 4) + '">' + target + '</text>';

    var pts = [], cols = [];
    for (var i = NC_LO; i <= NC_HI; i++) {
      if (isFinite(res.lp[i])) { pts.push(x(i - NC_LO) + ',' + y(res.lp[i])); cols.push(i); }
    }
    if (pts.length > 1) svg += '<polyline class="snd-result" points="' + pts.join(' ') + '"/>';
    cols.forEach(function (i) {
      var over = res.lp[i] > NC[target][i - NC_LO];
      svg += '<circle class="snd-dot' + (over ? ' snd-dot--over' : '') + '" cx="' +
        x(i - NC_LO) + '" cy="' + y(res.lp[i]) + '" r="4"><title>' + LABELS[i] +
        ' Hz: ' + fmt(res.lp[i]) + ' dB</title></circle>';
    });

    svg += '</svg>';
    $('chart').innerHTML = svg;

    $('legend').innerHTML =
      '<span><i class="snd-key snd-key--result"></i>Level in the room</span>' +
      '<span><i class="snd-key snd-key--target"></i>Target NC ' + target + '</span>' +
      '<span><i class="snd-key snd-key--over"></i>Band over target</span>' +
      '<span><i class="snd-key snd-key--nc"></i>NC 15 to NC 65</span>';
  }

  function renderTable(res) {
    var target = res.indoor ? CRITERIA[+$('nc-target').value].v : null;
    var h = '<thead><tr><th scope="col">Step</th>';
    LABELS.forEach(function (l) { h += '<th scope="col" class="num">' + l + '</th>'; });
    h += '<th scope="col" class="num">dB(A)</th></tr></thead><tbody>';

    function row(label, arr, cls) {
      var t = '<tr><th scope="row">' + esc(label) + '</th>';
      arr.forEach(function (v) {
        t += '<td class="num' + (cls ? ' ' + cls : '') + '">' + fmt(v) + '</td>';
      });
      return t + '<td class="num">' + fmt(dBA(arr)) + '</td></tr>';
    }

    h += row(state.paths.a.name + ' at terminal', res.A.lw);
    if (state.showB && res.B.used) {
      h += row(state.paths.b.name + ' at terminal', res.B.lw);
      h += row('Both paths combined', res.lwTotal);
    }
    if (!res.direct) {
      h += row(res.indoor ? 'Room effect' : 'Distance, air and barrier', res.term, 'snd-sub');
    }

    var t = '<tr class="snd-rowkey"><th scope="row">Level at the listener</th>';
    res.lp.forEach(function (v, i) {
      var over = target !== null && i >= NC_LO && i <= NC_HI && isFinite(v) &&
        v > NC[target][i - NC_LO];
      t += '<td class="num' + (over ? ' snd-over' : '') + '">' + fmt(v) +
        (over ? ' \u25B2' : '') + '</td>';
    });
    h += t + '<td class="num">' + fmt(res.dba) + '</td></tr>';

    if (target !== null) {
      var lim = [NaN, NaN].concat(NC[target]);
      h += row('NC ' + target + ' limit', lim, 'snd-sub');
    }
    if (res.indoor && res.rc) {
      h += row('RC Mark II contour', res.rc.contour.concat([NaN]), 'snd-sub');
    }

    $('table').innerHTML = h + '</tbody>';
  }

  /* Max duct velocity for the selected criterion. Reference data made active:
     it changes with the target rather than sitting in a static table. */
  function renderDuctV() {
    if ($('mode').value === 'outdoor') { $('ductv').innerHTML = ''; return; }
    var target = CRITERIA[+$('nc-target').value].v;
    var pick = DUCT_V[DUCT_V.length - 1], i;
    for (i = 0; i < DUCT_V.length; i++) {
      if (target >= DUCT_V[i].nc) { pick = DUCT_V[i]; break; }
    }
    var h = '<p class="hint">Duct velocity that ASHRAE associates with an NC ' + pick.nc +
      ' design goal, for the elbow type shown. Exceed it and the ductwork itself starts ' +
      'generating the noise you are trying to control.</p>' +
      '<div class="table-wrap"><table class="data"><thead><tr><th scope="col">Fitting</th>' +
      '<th scope="col" class="num">m/s</th><th scope="col" class="num">fpm</th></tr></thead><tbody>';
    DUCT_V_COLS.forEach(function (c, k) {
      var v = pick.v[k];
      h += '<tr><th scope="row">' + esc(c) + '</th><td class="num">' +
        (v === null ? '—' : r1(v * 0.00508)) + '</td><td class="num">' +
        (v === null ? 'not advised' : v) + '</td></tr>';
    });
    $('ductv').innerHTML = h + '</tbody></table></div>';
  }

  // ------------------------------------------------- reference tables

  function renderReference() {
    var h = '<div class="table-wrap"><table class="data"><thead><tr>' +
      '<th scope="col">Band</th><th scope="col" class="num">Centre, Hz</th>' +
      '<th scope="col" class="num">Range, Hz</th>' +
      '<th scope="col" class="num">A-weight</th><th scope="col" class="num">C-weight</th>' +
      '</tr></thead><tbody>';
    BANDS.forEach(function (b, i) {
      h += '<tr><th scope="row">' + (i + 1) + '</th><td class="num">' + b +
        '</td><td class="num">' + EDGES[i] + '</td><td class="num">' +
        (A_WT[i] > 0 ? '+' : '') + A_WT[i].toFixed(1) + '</td><td class="num">' +
        (C_WT[i] > 0 ? '+' : '') + C_WT[i].toFixed(1) + '</td></tr>';
    });
    $('band-table').innerHTML = h + '</tbody></table></div>';

    var j = '<div class="table-wrap"><table class="data"><thead><tr>' +
      '<th scope="col">Octave band</th><th scope="col" class="num">Just noticeable</th>' +
      '<th scope="col" class="num">Clearly different</th>' +
      '<th scope="col" class="num">Twice as loud</th></tr></thead><tbody>';
    JND.forEach(function (r) {
      j += '<tr><th scope="row">' + r.band + '</th><td class="num">' + r.jnd +
        '</td><td class="num">' + r.sig + '</td><td class="num">' + r.dbl + '</td></tr>';
    });
    $('jnd-table').innerHTML = j + '</tbody></table></div>';

    var c = '<div class="table-wrap"><table class="data"><thead><tr>' +
      '<th scope="col">Space</th><th scope="col" class="num">Design criterion</th>' +
      '</tr></thead><tbody>';
    CRITERIA.forEach(function (x) {
      var parts = x.label.split(' — ');
      c += '<tr><th scope="row">' + esc(parts[0]) + '</th><td class="num">' +
        esc(parts[1] || ('NC ' + x.v)) + '</td></tr>';
    });
    $('crit-table').innerHTML = c + '</tbody></table></div>';
  }

  /* Blade pass frequency: f = blades × rpm / 60. Tells you which octave band a
     fan's tone will land in, which is where a spectrum will spike. */
  function renderBpf() {
    var blades = parseFloat($('bpf-blades').value);
    var rpm = parseFloat($('bpf-rpm').value);
    var out = $('bpf-out');
    if (!isFinite(blades) || !isFinite(rpm) || blades <= 0 || rpm <= 0) {
      out.textContent = 'Enter blade count and speed.';
      return;
    }
    var f = blades * rpm / 60;
    var band = 0, best = Infinity, i;
    for (i = 0; i < BANDS.length; i++) {
      var d = Math.abs(Math.log(f / BANDS[i]));
      if (d < best) { best = d; band = i; }
    }
    out.textContent = r1(f) + ' Hz — falls in the ' + LABELS[band] +
      ' Hz octave band. Expect the spectrum to peak there, and a tone if it stands ' +
      '5 to 6 dB above the neighbouring bands.';
  }

  // ------------------------------------------------------------ wiring

  function syncMode() {
    var mode = $('mode').value;
    var direct = mode === 'direct', indoor = mode === 'indoor';
    $('room-panel').hidden = direct;
    $('indoor-inputs').hidden = !indoor;
    $('outdoor-inputs').hidden = indoor || direct;
    $('nc-target-wrap').hidden = !(indoor || direct);
    $('dba-target-wrap').hidden = indoor || direct;
    $('quantity-wrap').hidden = direct;
    $('room-label').textContent = indoor ? 'Receiving room' : 'Propagation to the receiver';
    $('lp-dist-wrap').hidden = direct || $('quantity').value !== 'lp';
  }

  function applyEquip() {
    var cfg = EQUIP[$('equip').value];
    $('mode').value = cfg.mode;
    $('absorb').value = cfg.room;
    $('nc-target').value = String(cfg.crit);
    state.showB = cfg.twoPaths;
    state.paths.a.name = cfg.a.name;
    state.paths.a.type = cfg.a.type;
    state.paths.b.name = cfg.b.name;
    state.paths.b.type = cfg.b.type;
    $('equip-help').textContent = cfg.help;
    $('toggle-b').textContent = state.showB ? 'Remove second path' : 'Add second path';
    renderPaths();
    syncMode();
    render();
  }

  function loadExample() {
    var k = $('example').value;
    if (!k) return;
    var note = $('example-note');

    if (k === 'clear') {
      state.paths.a = blankPath(state.paths.a.name, state.paths.a.type);
      state.paths.b = blankPath(state.paths.b.name, state.paths.b.type);
      note.hidden = true;
    } else {
      var ex = EXAMPLES[k];
      $('weighting').value = ex.weighting;
      $('quantity').value = ex.quantity || 'lw';
      if (ex.mode) $('mode').value = ex.mode;
      if (ex.dist) $('lp-dist').value = ex.dist;

      state.paths.a = blankPath(ex.a.name, ex.a.type);
      state.paths.a.bands = ex.a.bands.map(String);

      if (ex.single) {
        state.showB = false;
        state.paths.b = blankPath('Path B', 'ducted');
      } else {
        state.showB = true;
        state.paths.b = blankPath(ex.b.name, ex.b.type);
        state.paths.b.bands = ex.b.bands.map(String);
        state.paths.b.elements = { flex15: 1, end200: 1 };
      }
      $('toggle-b').textContent = state.showB ? 'Remove second path' : 'Add second path';
      note.textContent = ex.note;
      note.hidden = false;
    }
    renderPaths();
    syncMode();
    render();
    $('example').value = '';
  }

  function onChange(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    var role = t.getAttribute('data-role');
    var key = t.getAttribute('data-path');

    if (t.id === 'equip') { applyEquip(); return; }
    if (t.id === 'example') { loadExample(); return; }
    if (t.id === 'bpf-blades' || t.id === 'bpf-rpm') { renderBpf(); return; }

    if (role === 'type' && key) {
      state.paths[key].type = t.value;
      $('p' + key + '-chainbody').innerHTML = elementMarkup(key);
      typeHelp(key);
    }
    if (role === 'el' && key) {
      var id = t.getAttribute('data-el');
      var cnt = document.querySelector('[data-role="elcount"][data-path="' + key + '"][data-el="' + id + '"]');
      if (t.checked) {
        state.paths[key].elements[id] = cnt ? (parseInt(cnt.value, 10) || 1) : 1;
        if (cnt) cnt.disabled = false;
      } else {
        delete state.paths[key].elements[id];
        if (cnt) cnt.disabled = true;
      }
    }
    if (role === 'elcount' && key) {
      var id2 = t.getAttribute('data-el');
      if (state.paths[key].elements[id2] !== undefined) {
        state.paths[key].elements[id2] = parseInt(t.value, 10) || 1;
      }
    }
    if (t.id === 'mode' || t.id === 'quantity') syncMode();
    render();
  }

  function init() {
    fillSelects();
    renderReference();
    renderBpf();
    applyEquip();
    document.addEventListener('input', onChange);
    document.addEventListener('change', onChange);
    $('toggle-b').addEventListener('click', function () {
      state.showB = !state.showB;
      this.textContent = state.showB ? 'Remove second path' : 'Add second path';
      renderPaths();
      render();
    });
    $('btn-print').addEventListener('click', function () { window.print(); });
  }

  document.addEventListener('tn:ready', init);
})();
