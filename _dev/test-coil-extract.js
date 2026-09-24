/* Headless checks for tools/coil-data-extractor/coil-parse.js and xlsx-out.js
   Run with: node _dev/test-coil-extract.js [optional quotation.docx ...]
   No dependencies (Node 18+ for DecompressionStream / CompressionStream).

   The fixtures below are cut from real WinCoil quotations: the Word rows keep
   the empty first column and the "SHR" label that sits inside a smart tag, and
   the PDF items keep pdf.js's habit of splitting words ("Y" "our" "R" "ef.")
   and wrapping "Item 10:" and "Evaporating temperature" onto two lines.
   Pass real .docx files on the command line to run them end to end too. */

'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var dir = path.join(__dirname, '..', 'tools', 'coil-data-extractor');
var sandbox = {
  console: console, TextDecoder: TextDecoder, TextEncoder: TextEncoder,
  Blob: Blob, Response: Response, Map: Map, Uint8Array: Uint8Array,
  DecompressionStream: globalThis.DecompressionStream,
  CompressionStream: globalThis.CompressionStream,
};
sandbox.self = sandbox;
vm.createContext(sandbox);
['coil-parse.js', 'xlsx-out.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
});
var cp = sandbox.coilParse;

var checks = 0, failures = 0;
function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) {
    failures++;
    console.error('FAIL ' + label + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
  }
}
function col(table, row, name) { return table.rows[row][table.columns.indexOf(name)]; }

/* ---------------- Word: XML -> rows -> record ---------------- */
function tc(t) { return '<w:tc><w:p>' + (t ? '<w:r><w:t>' + t + '</w:t></w:r>' : '') + '</w:p></w:tc>'; }
function tr(cells) { return '<w:tr>' + cells.map(tc).join('') + '</w:tr>'; }
var docXml = '<w:document><w:body><w:tbl>' +
  tr(['Reference:', 'Item 1:Cold water coil', 'FCU-B08.01-FF-05To08', '', '']) +
  tr(['PHYSICAL DATA']) +
  tr(['', 'Finned height', '610', 'mm', '24.00', 'ins']) +
  tr(['', 'Fin configuration', 'Corrugated rippled edge', '', 'Corrugated rippled edge', '']) +
  tr(['', 'Number of rows', '6', '', '6', '']) +
  tr(['AIR DATA']) +
  tr(['', 'Total capacity', '17.90', 'kW', '61090', 'Btu/hr']) +
  tr(['', 'Condensate', '~', 'l/min', '~', 'gal/hr']) +
  '<w:tr>' + tc('') + '<w:tc><w:p><w:smartTag><w:r><w:t>SHR</w:t></w:r></w:smartTag></w:p></w:tc>' +
    tc('100') + tc('%') + tc('100') + tc('%') + '</w:tr>' +
  tr(['FLUID DATA']) +
  tr(['', 'Medium', 'Water', '', 'Water', '']) +
  tr(['', 'Flow rate', '0.48', 'l/s', '6.33', 'Imperial gpm']) +
  tr(['PRICING', 'Quantity', 'Price each: Nett ex works', 'Delivery']) +
  tr(['Item 1:', 'CW-3/8th 1 in Equat. -CW-AHRI-2.1-740-609.6-6R-9-S-Cu 0.30/Al 0.11', '2', '', '']) +
  tr(['Coil is NOT certified by AHRI. &amp; noted']) +
  '</w:tbl></w:body></w:document>';
var headerXml = '<w:hdr><w:tbl>' +
  tr(['Customer:', 'Daikin Middle East and Africa FZE', 'Your Ref. :', 'DVF FCUs - SFMC', 'Date:', '9/12/2025']) +
  tr(['Mob :', '+971 5888 38 774', 'WinCoil Version: 1.68.0008']) +
  '</w:tbl></w:hdr>';

var docRows = cp.docxRows(headerXml, 'header').concat(cp.docxRows(docXml, 'body'));
var doc = cp.interpret(docRows);
eq(doc.items.length, 1, 'word: one coil');
var wt = cp.buildTable(doc.items.map(function (it) { return { file: 'a.docx', item: it }; }), {});
eq(col(wt, 0, 'Item'), 1, 'word: item number');
eq(col(wt, 0, 'Reference'), 'FCU-B08.01-FF-05To08', 'word: reference tag');
eq(col(wt, 0, 'Coil type'), 'Cold water coil', 'word: coil type');
eq(col(wt, 0, 'Finned height (mm)'), 610, 'word: numeric value with unit header');
eq(col(wt, 0, 'Fin configuration'), 'Corrugated rippled edge', 'word: text value');
eq(col(wt, 0, 'Number of rows'), 6, 'word: unitless value');
eq(col(wt, 0, 'Total capacity (kW)'), 17.9, 'word: capacity');
eq(col(wt, 0, 'Condensate (l/min)'), '', 'word: "~" left blank');
eq(col(wt, 0, 'SHR (%)'), 100, 'word: label inside a smart tag');
eq(col(wt, 0, 'Flow rate (l/s)'), 0.48, 'word: fluid data');
eq(col(wt, 0, 'Quantity'), 2, 'word: quantity');
eq(col(wt, 0, 'Coil code'), 'CW-3/8th 1 in Equat. -CW-AHRI-2.1-740-609.6-6R-9-S-Cu 0.30/Al 0.11', 'word: coil code');
eq(col(wt, 0, 'Notes'), 'Coil is NOT certified by AHRI. & noted', 'word: note, entity decoded');
eq(col(wt, 0, 'Customer'), 'Daikin Middle East and Africa FZE', 'word: header customer');
eq(col(wt, 0, 'Your Ref.'), 'DVF FCUs - SFMC', 'word: header reference');
eq(col(wt, 0, 'Date'), '9/12/2025', 'word: header date');
eq(col(wt, 0, 'WinCoil version'), '1.68.0008', 'word: header version');
eq(wt.columns.indexOf('Total capacity (Btu/hr)'), -1, 'word: no imperial columns by default');

var wi = cp.buildTable(doc.items.map(function (it) { return { file: 'a.docx', item: it }; }), { imperial: true });
eq(col(wi, 0, 'Total capacity (Btu/hr)'), 61090, 'word: imperial column when asked');
eq(wi.columns.indexOf('Number of rows (imperial)'), -1, 'word: no imperial copy of a unitless field');
eq(wi.columns.indexOf('Total capacity (Btu/hr)'), wi.columns.indexOf('Total capacity (kW)') + 1, 'word: imperial sits beside metric');

/* ---------------- PDF: text items -> rows -> record ---------------- */
function it(s, x, y, w, h) { return { str: s, transform: [h || 9, 0, 0, h || 9, x, y], width: w, height: h || 9 }; }
var items = [
  it('Customer:', 39.4, 727.4, 45.1), it('DAIKIN MIDDLE EAST & AFR', 107.2, 727.4, 124.4), it('ICA FZE', 231.7, 727.4, 35),
  it('Y', 310.4, 727.4, 6), it('our', 316.4, 727.4, 14.5), it('R', 333.4, 727.4, 6.5), it('ef.', 339.9, 727.4, 10.5),
  it(':', 364.3, 727.4, 3), it('Diriyah project', 378.1, 727.4, 63.1), it('Date:', 477.2, 727.4, 22.5),
  it('24/', 513.8, 727.4, 12.6), it('09', 526.4, 727.4, 10), it('/2026', 536.5, 727.4, 22.4),
  it('Yours faithfully', 39.4, 120, 59), it('Filename :', 385, 120, 42),
  it('Reference:', 39.8, 665.4, 46.6), it('Item 10:DX coil', 187, 665.4, 59.6),
  it('FSU.B', 309.8, 665.4, 27), it('2. A.', 336.8, 665.4, 19.1), it('01C', 355.9, 665.4, 16.6),
  it('PHYSICAL DATA', 39.8, 643.2, 72.9),
  it('Finned length', 80.7, 621.7, 54.6), it('750', 187, 621.7, 15.1), it('mm', 293.3, 621.7, 15.1),
  it('29.53', 399.7, 621.7, 22.6), it('ins', 506, 621.7, 11.6),
  it('Fin configuration', 80.7, 590.6, 66.6), it('Corrugated rippled edge', 187, 591.5, 86.3, 8.04),
  it('Corrugated rippled edge', 399.7, 591.5, 86.3, 8.04),
  it('FLUID DATA', 39.8, 295.6, 54),
  it('Evaporating', 80.7, 253.5, 48), it('temperature', 80.7, 243, 48.5),
  it('7.0', 187, 253.5, 12.5), it('°C', 293.3, 253.5, 10.1), it('~', 399.7, 253.5, 5.3), it('°F', 506, 253.5, 9.1),
  it('~', 187, 232.7, 5.3), it('°C', 293.3, 232.7, 10.1), it('~', 399.7, 232.7, 5.3), it('°F', 506, 232.7, 9.1),
  it('Total pressure drop', 80.7, 222.4, 78), it('24.25', 187, 222.4, 22.6), it('kPa', 293.3, 222.4, 15.6),
  it('PRICING', 39.8, 212.4, 37.5), it('Quantity', 350.1, 212.4, 36.5),
  it('Price each: Nett ex', 399.7, 212.4, 80.5), it('works', 399.7, 202, 26.1),
  it('Item', 39.8, 190.9, 17.6), it('10:', 39.8, 180.6, 12.6),
  it('DX', 80.7, 190.9, 12.5), it('-', 93.1, 190.9, 3), it('3/8th 1 in Equat.', 96.1, 190.9, 65.6),
  it('-', 161.8, 190.9, 3), it('2.1-750-609.6-3R-6-S-Cu 0.36/Al 0.11', 164.8, 190.9, 150), it('1', 366.9, 190.9, 5),
  it('Coil is NOT certified by AHRI.', 39.8, 171.3, 92, 6.96),
];
var pdf = cp.interpret(cp.pdfRows(items, 'page 10'));
eq(pdf.items.length, 1, 'pdf: one coil');
var pt = cp.buildTable(pdf.items.map(function (x) { return { file: 'b.pdf', item: x }; }), {});
eq(col(pt, 0, 'Item'), 10, 'pdf: item number');
eq(col(pt, 0, 'Reference'), 'FSU.B2. A.01C', 'pdf: split runs rejoined');
eq(col(pt, 0, 'Location'), 'page 10', 'pdf: page recorded');
eq(col(pt, 0, 'Finned length (mm)'), 750, 'pdf: value');
eq(col(pt, 0, 'Fin configuration'), 'Corrugated rippled edge', 'pdf: smaller font on the same row');
eq(col(pt, 0, 'Evaporating temperature (°C)'), 7, 'pdf: wrapped label joined');
eq(pt.columns.some(function (c) { return /^Unlabelled/.test(c); }), false, 'pdf: empty unlabelled row dropped');
eq(col(pt, 0, 'Coil code'), 'DX-3/8th 1 in Equat.-2.1-750-609.6-3R-6-S-Cu 0.36/Al 0.11', 'pdf: coil code, "Item 10:" wrapped');
eq(col(pt, 0, 'Quantity'), 1, 'pdf: quantity');
eq(col(pt, 0, 'Notes'), 'Coil is NOT certified by AHRI.', 'pdf: note kept, footer not');
eq(col(pt, 0, 'Customer'), 'DAIKIN MIDDLE EAST & AFRICA FZE', 'pdf: header customer');
eq(col(pt, 0, 'Your Ref.'), 'Diriyah project', 'pdf: header reference with split ":"');
eq(col(pt, 0, 'Date'), '24/09/2026', 'pdf: header date');

/* ---------------- mixed sources share columns ---------------- */
var mixed = cp.buildTable(
  doc.items.map(function (x) { return { file: 'a.docx', item: x }; })
    .concat(pdf.items.map(function (x) { return { file: 'b.pdf', item: x }; })), {});
eq(mixed.rows.length, 2, 'mixed: two rows');
eq(col(mixed, 1, 'Fin configuration'), 'Corrugated rippled edge', 'mixed: shared column');
eq(col(mixed, 0, 'Evaporating temperature (°C)'), '', 'mixed: field missing from one file left blank');
eq(mixed.columns.filter(function (c) { return c === 'Fin configuration'; }).length, 1, 'mixed: no duplicate columns');

/* ---------------- workbook + optional real files ---------------- */
(async function () {
  var bytes = await sandbox.xlsxOut.build([{ name: 'Coils', columns: mixed.columns, rows: mixed.rows }]);
  eq(bytes[0] === 0x50 && bytes[1] === 0x4b, true, 'xlsx: zip signature');
  var sheetText = new TextDecoder().decode(bytes);
  checks++;
  if (typeof CompressionStream === 'undefined' && !/<v>610<\/v>/.test(sheetText)) {
    failures++; console.error('FAIL xlsx: numeric cell not written as a number');
  }

  var files = process.argv.slice(2);
  for (var i = 0; i < files.length; i++) {
    var buf = fs.readFileSync(files[i]);
    var rows = await cp.rowsFromDocx(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    var got = cp.interpret(rows);
    var t = cp.buildTable(got.items.map(function (x) { return { file: files[i], item: x }; }), {});
    console.log(path.basename(files[i]) + ': ' + got.items.length + ' coils, ' + t.columns.length + ' columns');
    checks++;
    if (!got.items.length) { failures++; console.error('FAIL ' + files[i] + ': no coils found'); }
  }

  console.log((failures ? 'FAILED ' : 'ok ') + (checks - failures) + '/' + checks + ' checks');
  process.exit(failures ? 1 : 0);
})();
