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

### 2.11 Model name mapping (optional)

If the Parts List Overview workbook is supplied, each row gains `MCQ-Modelname`,
`DENV-Modelname` and `Model Match`. The parts lists identify a unit only by a column
header like `MNG Mono 029.1`; the overview maps a full MCQ model name to its DENV
equivalent. **The MCQ names never appear in the parts lists**, so they have to be
reconstructed from what is there — file name, sheet name, column header.

Three keys, narrowest first:

1. **Parts list number, from the file name.** `n_19-McEnergy_Mono...` and `n°19-...`
   both give 19, which is the `Parts list n°` column in the overview. This alone cuts
   ~2,970 rows to a few dozen, and it is what lets the other two keys be loose without
   going wrong. If the file name carries no number the whole table is searched, and
   `Model Match` says `all lists` so the weaker scope is visible.
2. **Capacity, from the column header.** `MNG Mono 029.1` → `029.1`, which must appear
   in the model name. This is the real discriminator — it separates a unit from its
   siblings in the same family. Leading zeros differ between the two spellings, so
   `29.1` and `029.1` are both tried.
3. **Everything else, scored not filtered.** Alphabetic tokens from the sheet name and
   the header (`MONO`, `SE`, `ST`, `LN`, `MNG`) are counted as substrings of the model
   name, and every candidate on the top score is kept.

#### Variants are matched as tokens, not substrings

Step 3 alone cannot tell `XXN` from `XN`: searching for `XN` finds it inside `XXN`, so
a sheet covering `ST-LN-XN` scored the XXN units just as highly and returned them too.
A sheet name declares its variants as a **list**, so they are treated as a list —
membership, not containment.

Each model name is split around its capacity into three meaningful parts:

```
ALSFSE178.2ST134   ->  prefix "ALSFSE"  cap "178.2"  suffix variant "ST"
ALSFSE178.2XXN134  ->  prefix "ALSFSE"  cap "178.2"  suffix variant "XXN"
```

- **Suffix variant** must be a token the sheet name declares. On
  `1. ALS F 2 C. SE-XE~ST-LN-XN`, `ST` qualifies and `XXN` does not. This is right, and
  the workbook proves it: `2. ALS F 2 C. SE-XE~XXN` is a separate sheet.
- **Prefix variant** is whichever declared token the prefix *ends with* — `ALSFSE`
  ends with `SE`, `ALSFXE` with `XE`. Longest match wins so a short token cannot
  shadow a longer one.

When a sheet covers more than one build, two rules pick between them:

- A **qualifier** in the header wins. `Econ` (economiser) means the high-efficiency
  build, which is `XE`. This is domain knowledge, not something derivable from the
  files — it lives in `VARIANT_SYNONYMS` and is the place to add others.
- With **no qualifier**, the first build the sheet name lists wins. `SE-XE` means SE
  is the base build, so an unqualified header is the SE unit.

Both of these are **inferences from the data, not documented rules**. They are the two
lines to revisit first if a result looks wrong.

#### One row per matched model

A header matching several units used to produce one cell holding `A / B / C`, which
cannot be filtered, sorted, pivoted or looked up. Each match now gets its own row,
immediately below the first, numbered in `Model #` (1 of n) with the count repeated in
`Model Match` so the group stays identifiable once the sheet has been sorted.

**Every other cell is repeated on those rows, not left blank.** An earlier version
carried only the model columns and blanked the rest, which reads more tidily on a
printed sheet and is wrong for everything else: a filter on `DENV-Modelname` returns
rows with no part number, a sort scatters the continuation rows away from their
parent, and a pivot cannot attribute a blank-keyed row to anything. A repeated value
costs a little file size and survives all three.

Sheet size grows with the ambiguity: on a five-workbook run, 30,532 rows became
46,687 — about 1.5x. With no overview supplied the grain is unchanged and the model
columns are absent entirely.

#### The capacity is matched as a number, not as text

`includes()` cannot tell a number from a run of characters: `65.2` sits inside `165.2`.
Because leading zeros are inconsistent between headers and model names, the matcher
tries the zero-stripped form too — so a header for **065.2 also claimed the 165.2
unit**, and the two headers came back sharing a model name. That is what a user sees as
"the same model name on many different rows".

`hasCapacity()` requires a non-digit on the left and no digit on the right, so the match
is a whole number. A "." on the right is still allowed, so a header carrying only the
whole part (`184`) still matches a model built on `184.2`.

Real collisions in this overview: **065.2/165.2 in lists 21 and 31**, and
**049.2/149.2 plus 057.2/157.2 in list 30**. Sweeping every capacity in every list —
457 queries across 31 lists — the old code returned a wrong-capacity model on 4 of
them and the fixed code on none.

#### A capacity has two or more digits

A lone digit is a series or revision marker, never a capacity. Treating one as a
capacity is ruinous: `600VZ SSA1` tokenises to `600, VZ, SSA, 1`, and that trailing
`1` — from `SSA1`, not a capacity at all — matches **every** model whose name ends in
`A1`. Every EWWD-VZ header then claimed the same set of models. Capacity tokens now
need a decimal or two digits.

#### The MCQ column sometimes holds a family label

The first row of many lists carries the family in the MCQ column — `EWWD-VZ`,
`EWAD-TZ-B`, `EWYD~4Z` — rather than a model name. Matching ran against the MCQ name
whenever one existed, so that row matched nothing and **the model it hid was the first
of its family**: `EWWD600VZ-SSA1` and `EWAD160TZSSB1` were both missing from their own
results. A label carries no capacity, so a name without one now falls through to the
DENV side. This took the entries with no capacity in their match target from **43 to
5**, and model reachability across the overview to 2,886 of 2,891.

The remaining 5 have a family label in the *DENV* column too (`EWAD-M-B`, `EWAD-MZC`,
`EWAD-MZD`, `EWAH-MZD`, `EWWQ~KB/KA`), so there is no model name on those rows at all —
a gap in the overview, not in the matching.

#### The build letter after the capacity

`190S`, `190X` and `190P` are three different builds and were returning the same nine
models. The letters after the capacity carry the distinction: the header says `S`, the
model says `TZ` then `SSB1`. `TZ` is the family marker, shared by every model in the
list, so it is found as the common prefix of all their tails and removed from both
sides; what remains is the build. Each of those headers now returns its own three noise
variants.

Families whose capacity is a decimal have no letters directly after it (`178.2` is
followed by `.`), so they produce an empty tail here and are left to the prefix/suffix
rules above untouched. The narrowing is also skipped whenever it would leave nothing,
so it can never turn a match into a blank.

#### "--" is not a model name

Parts list 20 has `--` in the DENV column on **all 77 of its rows**. Every header in
that workbook therefore came back with the same `--`, which is indistinguishable from a
matching fault. A dash-only, `n/a`, `tbd` or `none` value is now blanked. The MCQ name
on those rows is real, so the entry is kept and still matched on; only the DENV name is
empty, and `QA_Model_Map` shows the gap so it can be fixed in the overview.

`joinNames()` collapses an all-blank list to `""` rather than `" / "`. Only the
all-blank case collapses, so the index alignment the one-row-per-model split depends on
is preserved wherever any real name exists.

#### One header legitimately maps to several units

Sheet `Mono SE ST_LN` covers both the standard and low-noise variants, and parts list
19 covers the condenserless (CU) units too. So `MNG Mono 029.1` maps to four DENV
names — `EWAD100E-SS`, `EWAD100E-SL`, `ERAD120E-SS`, `ERAD120E-SL` — and the quantity
in that column applies to all four. `1. 2C SE ST_LN` in the AWS workbook is the same
story: the name says ST *and* LN, so two answers is the correct number.

Across a five-workbook run, the token rules took the headers resolving to exactly one
model from 80 to 102 out of 197. The 60 that remain ambiguous are sheets whose own
name declares two variants — they are not failures to fix. This is not a matching failure; it is what the
source data says. All matches are listed, separated by ` / `, and the count is in
`Model Match`. Collapsing to one would be inventing an answer.

#### Two things the overview will do to you

**Over half its rows have a DENV name and no MCQ name** — newer units with no McQuay
equivalent. Requiring both would discard 1,653 of 2,970 rows and leave every parts
list built on those families unmatched. So a DENV name is required and the MCQ name is
a bonus; matching runs against whichever exists. For a DENV-only family that is right
anyway, because the parts list headers describe DENV units in the first place.

**Some rows are the placeholder text `No parts list assigned`** rather than a model
name. Skipped explicitly.

#### The header must identify a unit

A capacity is required. Without one, there is no match — `Qty`, `Remarks` or any
label the dictionary does not recognise returns nothing and is logged as
`no capacity in header`.

This is not tidiness, it is a crash fix. The words being scored include the **sheet
name's** tokens, which match every model in that family regardless of what the header
says. So a header carrying no capacity still scored above zero and matched the whole
pool — up to 2,968 models. Since every match becomes its own row, 399 parts expanded
into over a million and the writer died with `Invalid array length`. That message was
a runaway allocation, not a size limit.

Three guards now, narrowest first:

- **No capacity in the header → no match.** The capacity is the only thing that names
  a specific unit.
- **No name agreement → no match.** A capacity alone is not enough; the same number
  appears across unrelated families.
- **More than `MAX_MODEL_MATCHES` (12) → no match**, reported with the count. A header
  resolving to dozens of models has been guessed at, not identified.

Beyond those, the writer refuses to build a sheet over Excel's 1,048,576-row limit and
says which stage produced the rows, instead of failing with an allocation error.

#### Large results are written as CSV, not xlsx

`XLSX.write` builds the whole worksheet as one object with a property per cell and
then serialises it to a single XML string. Memory grows by several hundred bytes per
cell, and the tab dies past roughly two to three million cells — reported as
`Invalid array length` or `Too many properties to enumerate` depending on which
allocation gives out first. Neither message names the cause, and **no guard makes a
workbook that size writable**: measured in Node with a 1.8 GB heap, 100,000 rows x 19
columns wrote fine and 150,000 ran out of memory. Dense mode did not help, because the
XML string is built regardless.

So above `XLSX_CELL_BUDGET` (1,200,000 cells, about 63,000 rows at the full column
set) the parts table is written as **CSV** instead, from string chunks with no
per-cell objects. Measured on the same machine: 264,000 rows in 7 seconds, 59 MB, 256 MB
of heap. Excel and Power Query both open it directly.

The log and QA sheets are a few hundred rows, so they stay in a small companion
workbook and the page offers two downloads. Below the budget nothing changes — one
xlsx, exactly as before.

#### Failure mode

#### A family code can begin with a digit

`EWYS4004ZXSB2` is capacity **400** followed by the `4Z` family code. An earlier version
of the boundary check required a non-digit on the right as well as the left, which
rejected that and lost every 4Z family — lists 41, 65 and their relatives — after they
had been matching fine.

The left edge is the one that matters and stays strict: a digit or a "." before the
match means we have landed inside a longer number, which is the 065.2-inside-165.2
fault. The right edge is now *reported* rather than enforced. `capacityMatch` returns
`exact` when the capacity is the whole digit run and `loose` when more digits follow,
and the caller keeps the exact matches when any exist, falling back to loose ones only
when none do. So a hypothetical `1600` cannot steal a header for `160`, while a real
`4004Z` still resolves.

Across the overview, models reachable from their own capacity went from 2,925 of 2,968
to **2,886 of 2,891** — the denominator drops because list 20's 77 placeholder rows no
longer count as models.

A blank `DENV-Modelname` almost always means `no capacity match`: the capacity in the
header is not in the overview for that parts list. That is a gap in the overview, not
a matching failure — `ALS F 280.2 Econ` and `ALS F 297.2 Econ` have no row in it at
all. Check `QA_Model_Map` for the count, and the overview for those capacities.

A *wrong* parts list number produces the same `no capacity match` and an empty cell,
rather than a confident wrong answer — the capacity filter finds nothing in the wrong family and the
row is left blank. That is the desired direction to fail in.

### 2.12 Output

Five sheets:

| Sheet | Contents |
|---|---|
| `Parts_Long` | the table |
| `Extraction_Log` | every sheet scanned and what happened to it |
| `QA_Check_Headers` | columns treated as models whose text looks like a descriptor |
| `QA_Model_Renames` | where a code was spelled two ways and which won |
| `Model_Summary` | row counts per file, sheet and model |
| `QA_Model_Map` | one row per column header: what it matched and how |

`QA_Model_Map` is the sheet to eyeball once after adding the overview. It is a few
dozen rows rather than tens of thousands, and it shows every column header with its
matched MCQ and DENV names, the match count, and which keys were used.

`QA_Check_Headers` is the one to read after every run. It matches model names against
`part|number|stock|wiring|circuit|detail|item|drawing|description|critical|ref` and
flags any hit. Note there is deliberately **no closing word boundary** on that
pattern: with one, `Denv Partn°` did not match `\bpart\b`, because `part` is followed
by another word character — the test missed precisely the case it exists to catch.
Over-flagging here costs nothing; the sheet is meant to be read. A descriptor column with an unknown spelling gets treated as a model
column and silently unpivoted into nonsense — this catches that, and the fix is
always to add one alias to the dictionary.

---

## 2b. New format — EWAD lists that name their own models

Chosen with the **File format** toggle at the top of the page. The newer EWAD workbooks
print the full DENV model name in the row directly **above** the header, one per model
column:

```
row 0 |            | EWAD-M-C    |             |         | EWAD300M-SSC | EWAD400M-SSC2
row 1 |            |             | Part Number | Details | 300          | 400
row 2 | Compressor | HS-3118 ... | P3313...    | HSS3118 | 1            | -
```

So there is nothing to reconstruct: `DENV-Modelname` is read straight off the sheet and
the overview workbook is not used — its panel is hidden in this mode, and a map chosen
earlier is withheld from the run but remembered if you switch back.

### What is different from the old rules, and why

- **The header need not say "Description".** EWAD-M-C leaves that column unlabelled, so
  under the old rules the whole file produced nothing. Here a header needs a
  part-number column and at least one model column; the description column is
  inferred when unnamed.
- **The section is column A beside the parts**, not a banner row above them. Unlabelled
  columns left of the first labelled descriptor are read as Section, then (if
  Description is not named) Description.
- **A new section resets the carried description**, so a part left undescribed at the
  top of "Liquid Line" does not inherit the last compressor's text.
- **Description or part number** qualifies a row, same as the old format. Lines like
  *Economiser Expansion Valve* are real parts with no number issued yet; an early
  version required a part number and silently dropped 153 of them.

On every sheet both rule sets can read, the row sets are identical — EWAD-M-B 15,263
and EWAD-M6C 1,274 in both modes. The new mode adds sections and model names, and reads
EWAD-M-C, which the old mode could not.

### Sheets covered

Verified against EWAD-M-B, EWAD-M-C, EWAD-MZB, EWAD-MZC and EWAD-MZD: 18 parts sheets,
25,087 rows, 166 of 183 model columns named. The layouts differ more than they look:

| | model-name row | header row | gap between them | DENV part no. |
|---|---|---|---|---|
| EWAD-M-C | 0 | 1 | none | no |
| EWAD-MZC | 1 | 2 | none | yes |
| EWAD-MZB, EWAD-MZD | 1 | 3 | one blank row | no |

Taking the **nearest non-empty row above the header** rather than "the row above" is what
makes the blank-row layouts work. The header row itself is found by searching, so its
position is never assumed.

A section label missing from column A is reported, not invented. `EWAD-MZB`'s DUAL "XS"
and "PS" sheets omit the COMPRESSOR label that their SS sheet carries, leaving 131 and
194 rows with no section; the log says so per sheet.

### Model names are never repaired, only flagged

`QA_Model_Map` gets one row per model column. `Model Match` says one of:

| Value | Meaning |
|---|---|
| `from sheet` | name read from the row above, agrees with its code |
| `no model name in sheet` | nothing printed above that column — left blank |
| `check: code says S, model name says X` | the efficiency letter disagrees |
| `check: code … not found in model name` | the capacity in the code is not in the name |

Missing names are **not** filled in. `EWAD-MB 2C S Parts List` has none at all; building
`EWAD290M-SSB?` from the code `290S` would need a suffix digit the sheet does not give,
and a model name this tool made up is worse than a blank.

The sample set shows why the check exists: `EWAD-MB 3C S Parts List` prints XS model
names (`EWADH15M-XSB2`) over S codes (`H15S`) across all seven columns, and
`3C X Parts List` has one stray `H18S`. Those are source-file errors. The values are
kept as printed and flagged, so the fix happens in the source workbook.

### Same output schema as the old format

Identical columns in identical order: `MCQ-Modelname` is blank, `Model #` is 1. Output
from the two modes can be stacked into one table without reshaping. The CSV switch for
large results applies to both.

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
