# Parts List Extractor — logic and implementation notes

How the DAE/DENV spare parts extraction works, and how the browser tool that runs it
was built. Written so that someone who has never seen the source workbooks can pick
this up, and so that future-you can change a rule without re-deriving why it exists.

Publishing and hosting are out of scope here.

---

## 1. The problem

Ten workbooks of chiller spare parts lists, produced over years by different people
for different product families. They are meant for printing, not for querying, and
every convenience for the printer is an obstacle for the parser.

What varies between them, and often within one file:

| Variation | Example |
|---|---|
| Header row position | row 3 on one sheet, row 7 on the next |
| Header repeated per printed page | up to 24 times down one sheet |
| Header spelling | `Denv part number`, `Denv Part number`, `Part Number DENV` |
| Which descriptor columns exist | `Circuit` absent from EWAD-CZ, TZB, DZ, AGZ |
| Number of model columns | 4 on some sheets, 24 on others |
| Category banners | `Compressors`, `Compressor Parts` sitting in the Item column |
| Title and noise rows | `Page 18`, `Issue 4`, `Quantity for Each Chiller` |
| Merged cells, vertical | a Description spanning three continuation rows |
| Merged cells, horizontal | `1pc per compressor` spanning model columns I:N |
| Phantom columns | one sheet padded to 16,383 columns |
| Non-parts sheets | Front Page, Index, Drawings, Revisions |
| File format | five `.xlsx`, five legacy `.xls` |

The output wanted is one long table: every part, repeated once per model, with the
quantity in a `Value` column. Roughly 66,000 rows across the set.

### Why "long" and not a wide grid

A wide table would need one column per model code across all ten workbooks, most of
them empty for any given row, and would have to be restructured every time a new
model appears. The long shape absorbs new models as new *rows*, needs no schema
change, and is what a pivot table wants as its source anyway.

---

## 2. Extraction logic

Nine stages. Each exists because some sheet in the real set breaks without it.

### 2.1 Skip sheets by name

A substring match, case-insensitive, against `SHEET_BLACKLIST`:

```
front page, back page, index, drawings, revision, nomenclature,
conversion table, options list, electrical legend
```

This is an optimisation and a safety net, not the real filter — stage 2.3 would
reject these sheets anyway because they have no parts header. Skipping by name is
cheaper and makes the log easier to read.

### 2.2 Build the grid — twice

Every sheet becomes a rectangular array of strings. Two copies are kept, and the
distinction between them matters more than anything else in this document:

- **`raw`** — merged values appear only in the top-left cell, exactly as the file
  stores them.
- **`grid`** — every merged region is filled across all the cells it covers.

Structure *detection* reads `raw`. Value *extraction* reads `grid`.

The reason: a category banner like `Compressors` is often a cell merged across the
full width of the table. In `grid` that banner has been smeared into every column,
including the Description and part-number columns, so the row would look like a real
part row with the same text repeated. In `raw` it is one populated cell followed by
blanks, which is exactly the shape the banner test looks for.

Cell values are normalised on the way in: whole floats lose their `.0` (Excel stores
`1` as `1.0`), dates become ISO strings, and all internal whitespace including in-cell
newlines collapses to single spaces. That last one matters — `"Suction filter\nkit "`
and `"Suction filter kit"` must be the same string or fill-down comparisons fail.

Rows are trimmed of trailing blanks and then capped at `MAX_COLS = 256`. The cap is
what stops the 16,383-column sheet from producing a 16,383-wide array for every one
of its rows.

### 2.3 Find the header row — by searching, not by position

A row is a parts-list header when **all three** hold:

1. one of its cells maps to `Description`, and
2. one maps to `Part Number DENV` **or** `Part Number DAE`, and
3. at least `MIN_MODEL_COLS = 1` cells map to nothing at all.

That third condition is the load-bearing one, and it inverts the obvious approach.
Rather than listing the model codes to look for — impossible, they change per product
family and per year — **anything not in the dictionary is assumed to be a model
column.** New model codes need no change to anything.

Header text is normalised before lookup: newlines and runs of whitespace collapse,
case is dropped, `n°` folds to `no`, and trailing `:` or `.` are stripped. A second
pass retries with all spaces removed, so `Denv Partnumber` still resolves.

The `n°` rule earns its place: it is the French abbreviation for *number*, and headers
written at the Belgian and French sites use it — `Denv Partn°`, `Part n°`. Folding it
in `norm()` means one rule instead of an alias per punctuation variant, and it catches
both the degree sign (U+00B0) and the masculine ordinal (U+00BA), which both appear.

The same test runs against *every* row, not just the first match. That single decision
handles two problems at once: the header can sit anywhere, and every repeated page
header further down is recognised and skipped rather than becoming a data row. When a
repeat carries a *different* model list, the model mapping is replaced from that row
on and the `headerVariants` counter increments — some sheets genuinely change layout
partway down, and the log reports it.

#### Repeats merge, they do not replace

A repeated page header often omits labels the first header carried — the printer only
needed them at the top of the sheet. Replacing the mapping wholesale on every repeat
therefore **drops those columns for the rest of the sheet, silently**: the column ends
up in neither the descriptor mapping nor the model list, so nothing ever reads it, and
nothing reports it either.

This is not hypothetical. In `n°19 McEnergy Mono`, `Denv Partn°` is labelled only in
the header on row 2; the ten repeats below it leave that cell blank. Wholesale
replacement lost 142 of 150 DENV part numbers and put the other 8 in the wrong column.

So a repeat is merged into what is already known: a previous mapping is retained only
where the repeat leaves that column **genuinely blank**. A repeat that *renames* a
column still wins — `DAE Partn°` appearing where `Denv Partn°` used to be moves the
column, it does not get overruled by history.

### 2.4 Drop title and noise rows

Two rules, both against `raw`:

- The row matches `quantity for each` anywhere.
- The first populated cell starts with `page N` or `issue N`, **and** the row has four
  or fewer distinct values.

The second condition on that last rule is the guard. Without it, a genuine part
described as `Issue 4 gasket set` in a row of otherwise ordinary data would be
discarded. A real title row is a handful of cells; a part row is not.

### 2.5 Capture category banners into `Section`

A row is a banner when the Description and both part-number columns are empty, no
model column has a value, and the first populated cell is in column index 0, 1 or 2.

The value becomes the current `Section` and applies to every part row that follows
until the next banner. The column-index limit is what distinguishes a banner from a
stray note further right.

### 2.6 Assemble the descriptor record

Nine canonical columns, read from `grid` at the indices the header mapping found:

```
Item · Drawing · Part Number DENV · Description · Part Number DAE
Details · Circuit · Wiring Diagram Reference · Stock Criticality
```

Columns a sheet does not have simply come out empty. Nothing errors, and when the
sheets are unioned at the end the gaps are just blanks.

### 2.7 Fill down continuation rows

Four columns carry their last non-empty value forward: `Item`, `Drawing`,
`Description`, `Circuit`.

This is for the printed-layout habit of writing an item number once and leaving the
following rows blank. Note it is *not* the same mechanism as merged-cell expansion —
a genuinely merged cell is already handled in stage 2.2. Fill-down covers cells that
are simply blank because the author did not repeat themselves.

The fill-down memory resets at every header row. A repeated page header means a new
printed page, and values must not leak across that boundary.

### 2.8 Reject rows that are not parts

Two filters, in order:

1. No `Description` and no part number in either column → not a part.
2. No value in *any* model column → not a part.

The second catches sub-headings and stray annotations that survive everything above.
A real part row has at least one quantity somewhere.

### 2.9 Unpivot

For each surviving row, one output record per model column that has a value:

```
Source File · Sheet · Section · <nine descriptors> · Attribute · Value
```

`Attribute` is the model code, `Value` is the quantity. Empty cells produce no row.
With `keepDash` off, cells reading `-` or `0` produce no row either — the difference
between "every part in the catalogue" and "parts actually fitted to this model".

### 2.10 Canonicalise model codes

`MNG171.2` and `MNG 171.2` are the same chiller. Codes are keyed on their letters and
digits alone (`MNG1712`), and **the spelling from the first occurrence of that key
wins**, because the top-of-sheet header is more reliable than the repeated page
headers, which is where the typos live. The original spelling is preserved in
`Attribute Raw` so nothing is lost, and every substitution is listed in
`QA_Model_Renames`.

### 2.11 Output

Five sheets:

| Sheet | Contents |
|---|---|
| `Parts_Long` | the table |
| `Extraction_Log` | every sheet scanned and what happened to it |
| `QA_Check_Headers` | columns treated as models whose text looks like a descriptor |
| `QA_Model_Renames` | where a code was spelled two ways and which won |
| `Model_Summary` | row counts per file, sheet and model |

`QA_Check_Headers` is the one to read after every run. It matches model names against
`part|number|stock|wiring|circuit|detail|item|drawing|description|critical|ref` and
flags any hit. Note there is deliberately **no closing word boundary** on that
pattern: with one, `Denv Partn°` did not match `\bpart\b`, because `part` is followed
by another word character — the test missed precisely the case it exists to catch.
Over-flagging here costs nothing; the sheet is meant to be read. A descriptor column with an unknown spelling gets treated as a model
column and silently unpivoted into nonsense — this catches that, and the fix is
always to add one alias to the dictionary.

---

## 3. Web tool architecture

```
tools/parts-extractor/
  index.html            three panels: workbooks, options, result
  styles.css            tool-scoped only
  parts-extractor.js    file picking, progress, download
  extractor-worker.js   the whole extraction, plus SheetJS
```

### Three decisions worth recording

**Everything client-side.** Spare parts pricing and part numbers are commercially
sensitive; a tool that uploads them needs a security conversation that a tool which
does not, does not. The files never leave the machine.

**The extraction runs in a Web Worker.** Ten workbooks and ~66,000 rows is seconds of
solid CPU. On the main thread that is a frozen tab: no progress bar can paint, because
the browser cannot repaint while script is running, and no Cancel button can be
clicked. Moving the work off-thread is what makes both possible. The worker is a
*classic* worker rather than a module worker, because SheetJS is loaded with
`importScripts`, which module workers do not have.

**SheetJS as the only dependency.** It reads `.xlsx` and legacy `.xls`, exposes real
merged-cell ranges via `ws['!merges']`, and writes the multi-sheet output. Each of
those is impractical to hand-roll, and the merge ranges in particular are what make
this more accurate than the Power Query version, which has to guess at horizontal
merges with a text-length heuristic. Cost: about 900 KB, loaded only when this tool
runs.

### Data flow

```
user picks files
  → main thread reads each to an ArrayBuffer (FileReader)
  → buffers TRANSFERRED to the worker (not copied)
  → worker: per file → per sheet → grid → rows
  → worker posts { fraction, label } after each file
  → worker builds the workbook, transfers the buffer back
  → main thread wraps it in a Blob and offers the download
```

Buffers are transferred rather than copied in both directions. Ten workbooks of a few
MB each would otherwise be duplicated in memory at the boundary.

---

## 4. Implementation steps

Roughly the order it was built, and the order to rebuild it in.

**1 — Get the reference right first.** The Python tool was the specification. Before
writing any browser code, read it closely enough to list every rule and the *reason*
for each. Most of section 2 above is that list. Rules whose purpose you cannot state
are rules you will break by accident later.

**2 — Prove the browser can do the hard part.** Two questions decide feasibility:
can it read legacy `.xls`, and can it see merge ranges? Confirm both against a real
file before building any UI. If either had failed the whole approach changes.

**3 — Port the engine, not the structure.** Translate function by function, keeping
the same names and the same order, so the two can be read side by side. Resist
improving anything during the port — a port and a redesign at the same time gives you
no way to tell which change caused a difference.

**4 — Build a torture-test workbook.** One file containing every awkward feature from
section 1: header on row 3, a repeated header mid-sheet, two category banners, a
`Page 18` title row, a `Quantity for Each Chiller` noise row, an in-cell newline, a
vertical merge, a horizontal merge across model columns, a blacklisted sheet, and a
sheet that is not a parts list at all.

**5 — Diff against the reference.** Run both tools on that workbook and compare the
`Parts_Long` sheets cell for cell, sorted. Not row counts — cells. Row counts agree
by coincidence surprisingly often. Then assert each individual behaviour separately,
so a failure names itself instead of just saying "output differs".

**6 — Only then, the UI.** Panels in the order the work happens: workbooks, options,
result. Nothing parses until the button is pressed.

**7 — Progress and cancel.** Post a fraction after each *file*, not each row —
progress messages cross a thread boundary and thousands of them cost more than the
parsing. Show elapsed seconds once a run passes a few seconds.

**8 — Surface the log in the page.** The `Extraction_Log` sheet is the tool's most
useful output and it is buried inside a download. Render it on screen, and tint the
rows that need attention: red for a file that failed to open, amber for a sheet that
produced nothing. A sheet you expected to see data from, showing "no parts table
found", is the whole diagnostic.

---

## 5. Maintenance

**Adding a workbook family.** Drop it in and run. If a sheet you expected shows
"no parts table found", open it, read the header row, and add its spellings to
`HEADER_ALIASES` at the top of `extractor-worker.js`. That is the only maintenance
point. Adding an alias needs no other change.

**Adding a descriptor column.** Add it to `HEADER_ALIASES` *and* to
`DESCRIPTOR_ORDER`. Missing the second leaves it recognised but unwritten. If it
should also carry down into continuation rows, add it to `FILL_DOWN` too.

**A new noise row pattern.** Extend `TITLE_PAT` or `NOISE_PAT`, and check the
distinct-value guard still protects genuine data.

---

## 6. Known limits

**Two columns claiming the same canonical name.** The first one wins and the second is
dropped. If a sheet has both `DAE Partn°` and `Part Number`, only the leftmost reaches
`Part Number DAE`. Faithful to the Python reference, and not seen in the real set.

**The header dictionary is a whitelist by omission.** Because anything
unknown is treated as a model column, a *descriptor* column with an unrecognised
spelling becomes a phantom model. `QA_Check_Headers` exists specifically to catch
this, but it catches it after the fact — read that sheet.

**A corrupt or non-Excel file logs as "no parts table found"** rather than
"OPEN FAILED", because SheetJS parses the garbage instead of throwing. It is logged
and does not crash the run, but the message is misleading.

**No OCR and no images.** A scanned parts list produces nothing.

**Sheets are processed serially.** One worker, one file at a time. Parallelising
across several workers would be faster on a many-core machine and is not done.

**Memory scales with the output.** All rows are held in memory before the workbook is
written. Comfortable at tens of thousands of rows; a set several times larger than the
current ten workbooks would want streaming.

---

## 7. Where this differs from the Python reference

The browser tool was built as a faithful port and stays row-for-row identical to
`extract_parts_lists.py` on the test set. Two rules have since been added to it that
the Python does not have:

1. **`n°` folding** in `norm()`.
2. **Merging repeated headers** instead of replacing them (§2.3).

Both are fixes for real faults found in `n°19 McEnergy Mono`, and the Python has the
same faults on that file — it would also lose the DENV column. If the Python tool is
still in use, both changes are worth backporting: one line in `norm()`, and a merge
step where `mapping, models = m, mo` currently assigns.

---

## 8. Why the browser version is more accurate than the Power Query one

Two of the Power Query implementation's stated limits do not apply here.

**Horizontal merges.** Power Query sees a merged value only in its top-left cell, so
it infers the spread with a heuristic: one non-null model cell whose text is longer
than two characters is copied across all model columns. That misfires on any genuine
single-model quantity written as text. Reading the actual merge ranges removes the
ambiguity entirely.

**Legacy `.xls`.** Power Query needs the Access Database Engine provider installed to
open `.xls` at all, which is why half the set had to be re-saved. SheetJS reads BIFF
directly.
