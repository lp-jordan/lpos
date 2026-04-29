#!/usr/bin/env node
// Standalone PDF → HTML extractor. Invoked as a child process by the dashboard
// so pdfjs-dist runs in a fresh Node context, free of any webpack bundling.
//
// Usage: node extract-pdf-text.mjs <absolute-pdf-path>
// Writes HTML (UTF-8) to stdout: <p>, <h2>, and <strong> tags reconstructed
// from each text item's position, font height, and font name.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: extract-pdf-text.mjs <pdf-path>');
  process.exit(2);
}

const _require   = createRequire(import.meta.url);
const libUrl     = pathToFileURL(_require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
const workerUrl  = pathToFileURL(_require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

const pdfjs = await import(libUrl);
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const buffer = fs.readFileSync(filePath);
const task   = pdfjs.getDocument({
  data: new Uint8Array(buffer),
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
});
const doc = await task.promise;

// Collect line objects from every page so we can compute a global median
// font height (for heading detection) before rendering.
//   line = { y, height, items: [{ str, x, fontName, height }] }
const allLines = [];
const pageBoundaries = []; // index in allLines where each new page starts

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  // Populating operator list resolves fonts into commonObjs so we can
  // look up real font names (for bold detection) below.
  await page.getOperatorList();
  const content = await page.getTextContent();

  const pageLines = [];
  for (const item of content.items) {
    if (!item.str) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const h = item.height || item.transform[3] || 0;
    const tol = Math.max(h * 0.5, 1);
    let line = pageLines.find((l) => Math.abs(l.y - y) <= tol);
    if (!line) {
      line = { y, height: h, items: [] };
      pageLines.push(line);
    } else if (h > line.height) {
      line.height = h;
    }
    // Resolve real font name (e.g. "ArialMT-Bold") so we can detect bold
    let realFont = item.fontName;
    try {
      const obj = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null;
      if (obj && obj.name) realFont = obj.name;
    } catch { /* fall back to internal id */ }
    line.items.push({ str: item.str, x, fontName: realFont, height: h });
  }

  pageLines.sort((a, b) => b.y - a.y);
  for (const line of pageLines) line.items.sort((a, b) => a.x - b.x);

  pageBoundaries.push(allLines.length);
  allLines.push(...pageLines);
}

// Median line height across the whole document — anything noticeably
// taller becomes a heading.
const heights = allLines.map((l) => l.height).filter((h) => h > 0).sort((a, b) => a - b);
const median  = heights.length ? heights[Math.floor(heights.length / 2)] : 1;
const headingThreshold = median * 1.4;

// Walk lines and group into blocks. A block break happens when the
// vertical gap between two lines exceeds ~1.6× the previous line's
// height, OR when crossing a page boundary.
const out = [];
let block = null;
const pageBoundarySet = new Set(pageBoundaries);

function flushBlock() {
  if (!block || block.lines.length === 0) return;
  const lineHtmls = block.lines.map((line) => {
    let html = '';
    let prevX = null;
    for (const it of line.items) {
      const text = escapeHtml(it.str);
      const isBold = /bold|black|heavy/i.test(it.fontName || '');
      const piece  = isBold ? `<strong>${text}</strong>` : text;
      // Add a space between tokens that aren't already separated
      if (prevX !== null && !html.endsWith(' ') && !it.str.startsWith(' ')) {
        html += ' ';
      }
      html += piece;
      prevX = it.x;
    }
    return html;
  });
  const text = lineHtmls.join('<br>\n');
  const isHeading = block.lines.length === 1 && block.lines[0].height > headingThreshold;
  out.push(isHeading ? `<h2>${lineHtmls.join(' ')}</h2>` : `<p>${text}</p>`);
  block = null;
}

for (let i = 0; i < allLines.length; i++) {
  const line = allLines[i];
  const isNewPage = pageBoundarySet.has(i);
  if (!block) {
    block = { lines: [line] };
    continue;
  }
  const prev = block.lines[block.lines.length - 1];
  const gap  = prev.y - line.y;
  const sameBlock = !isNewPage && gap < prev.height * 1.6;
  if (sameBlock) {
    block.lines.push(line);
  } else {
    flushBlock();
    block = { lines: [line] };
  }
}
flushBlock();

process.stdout.write(out.join('\n'));
