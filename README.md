# Thinkneering — Tools

Two browser tools for engineering office work:

- **Compliance Maker** — turns a specification PDF (or pasted text) into a numbered
  compliance matrix and exports it as a formatted `.xlsx`.
- **Container Calculator** — works out how many containers or trailers a shipment
  needs, with a load plan, stowage drawings and a PDF report.
- **Parts List Extractor** — reads a set of spare parts list workbooks, finds the
  header row on every sheet, maps the varying spellings to one schema, expands
  merged cells and unpivots the per-model quantity columns into one long table.

Everything runs in the visitor's browser. There is no server, no database, no
accounts and no analytics. Files that are opened are read locally and never
uploaded anywhere.

## Publishing on GitHub Pages

1. Create a repository and upload the contents of this folder to the root of the
   default branch. `index.html` must sit at the top level of the repo, not inside
   a subfolder.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   choose your default branch and the `/ (root)` folder, then **Save**.
4. Wait for the green tick on the Actions/Pages run, then open the URL Pages
   shows you.

Nothing needs building, installing or configuring. There is no `package.json`,
no build step and no npm dependencies.

The `.nojekyll` file matters: without it GitHub runs the files through Jekyll,
which ignores folders beginning with an underscore and can rewrite output. Leave
it in place.

## Paths

Every internal link is relative and worked out at runtime from the location of
`assets/js/global.js`, so the site works both at a domain root
(`yourname.github.io`) and in a project subfolder
(`yourname.github.io/your-repo/`). You do not need to set a base URL.

## Running it locally

Open `index.html` directly and the home page will work, but the Container
Calculator will not: it is built from ES modules, which browsers refuse to load
from `file://`. Serve the folder over HTTP instead:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Structure

```
index.html                              home page, two tiles
assets/css/global.css                   design tokens + shared components
assets/js/global.js                     header, footer, theme toggle, helpers
data/highlight-rules.json               words the Compliance Maker highlights
tools/compliance-maker/
  index.html
  compliance-maker.js                   parser, highlighter, preview
  xlsx-writer.js                        writes the .xlsx, including cell fills
tools/container-calculator/
  index.html
  styles.css
  js/app.js, packer.js, draw.js, xlsx-io.js, pdf.js
tools/parts-extractor/
  index.html
  styles.css
  parts-extractor.js                    file picking, progress, download
  extractor-worker.js                   the extraction itself
```

## External dependencies

Two, each on one page only.

**pdf.js 3.11.174** on the Compliance Maker page, used to pull text out of an
uploaded PDF. Pasting text instead does not touch it.

**SheetJS 0.18.5** in the Parts List Extractor's worker, used to read `.xlsx`
and legacy `.xls` workbooks — including their merged-cell ranges, which is what
makes the extraction correct — and to write the output workbook. It is about
900 KB and loads only when that tool runs.

Everything else — the compliance matrix Excel writer, the PDF report writer,
the packing solver, the drawings — is hand-rolled and included here.

If you would rather not depend on a CDN, download `pdf.min.js` and
`pdf.worker.min.js` from that version, put them in `assets/vendor/pdfjs/`, and
change the `<script src>` in `tools/compliance-maker/index.html` and the
`workerSrc` line at the top of `compliance-maker.js` to point at them.

Fonts (Sora, Inter, JetBrains Mono) come from Google Fonts. If they fail to
load, the CSS falls back to the system sans-serif and the layout still holds.

## Editing

- Colours, spacing, radii and fonts are CSS custom properties at the top of
  `assets/css/global.css`. Change them there; nothing hardcodes a raw value.
- To add a tool: create `tools/<kebab-case-name>/index.html`, add one entry to
  `NAV` in `assets/js/global.js`, and one entry to `TOOLS` in `index.html`.
- The Parts List Extractor's header dictionary is `HEADER_ALIASES` at the top of
  `extractor-worker.js`. A workbook whose sheet reports "no parts table found"
  usually needs one new alias adding there and nothing else.
- The Compliance Maker's highlight words live in `data/highlight-rules.json`,
  as three lists: `red`, `redbold` and `underline`. All entries are lowercase;
  matching is case-insensitive and whole-word.

## Licence

`assets/css/global.css` and the tool code are yours. pdf.js is Apache-2.0.
