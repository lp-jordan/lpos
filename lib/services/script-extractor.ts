/**
 * Shared extraction utility for script files.
 *
 * Extracts content as HTML so formatting round-trips through
 * the LPOS editor back to LeaderPrompt without loss.
 *
 * .docx → mammoth.convertToHtml  (preserves bold, italic, headings, lists)
 * .pdf  → child-process pdfjs extractor → HTML with <p>, <br>, <strong>, <h2>
 * .txt  → plaintext wrapped in <p> paragraphs
 *
 * The resulting HTML is stored in the sidecar file (.extracted.txt) and is
 * used by the LPOS editor. For PDF/TXT originals we ALSO generate a sibling
 * .docx and re-point filePath at it so LeaderPrompt's GET /file fetch returns
 * a readable Word document instead of an unreadable raw PDF/TXT.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { patchScript, saveExtractedText } from '@/lib/store/scripts-registry';

function extractPdfTextViaChildProcess(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), 'scripts', 'extract-pdf-text.mjs');
    const child  = spawn(process.execPath, [script, filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`pdf extractor exited ${code}: ${stderr.trim()}`));
    });
  });
}

function textToHtml(text: string): string {
  // Split on blank lines to get paragraphs, escape HTML entities
  return text
    .split(/\n{2,}/)
    .map((para) =>
      `<p>${para.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`,
    )
    .filter((p) => p !== '<p></p>')
    .join('\n');
}

export async function extractAndSave(
  projectId: string,
  scriptId:  string,
  filePath:  string,
  ext:       string,
): Promise<void> {
  try {
    patchScript(projectId, scriptId, { status: 'processing' });

    let html = '';

    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const result  = await mammoth.convertToHtml({ path: filePath });
      html = result.value;
    } else if (ext === '.pdf') {
      // Run pdfjs-dist in a fresh Node child process to bypass any webpack
      // bundling/mangling that occurs when loading it inside the Next runtime.
      // The script returns HTML directly (paragraphs, line breaks, bold).
      html = await extractPdfTextViaChildProcess(filePath);
    } else if (ext === '.txt') {
      const text = fs.readFileSync(filePath, 'utf8');
      html = textToHtml(text);
    } else {
      // .doc or unknown — mark ready with no extracted content
      patchScript(projectId, scriptId, { status: 'ready' });
      return;
    }

    saveExtractedText(projectId, scriptId, html);
    patchScript(projectId, scriptId, { status: 'ready', hasExtractedText: true });

    // For PDF / TXT originals, also generate a .docx sibling so LeaderPrompt
    // (which polls GET /file) receives a readable Word document instead of the
    // raw PDF/TXT. We point the registry's filePath at the new .docx; the
    // original file stays on disk untouched (Drive sync already pushed it).
    if (ext === '.pdf' || ext === '.txt') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const htmlToDocxMod = await import('html-to-docx') as any;
        const htmlToDocx    = htmlToDocxMod.default ?? htmlToDocxMod;
        const buffer        = await htmlToDocx(html, undefined, {}) as Buffer;
        const docxPath      = filePath.replace(/\.[^.]+$/, '.docx');
        fs.writeFileSync(docxPath, Buffer.from(buffer));
        patchScript(projectId, scriptId, {
          filePath: docxPath,
          fileSize: fs.statSync(docxPath).size,
        });
      } catch (err) {
        console.error(`[script-extractor] docx generation failed for ${scriptId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[script-extractor] failed to extract ${scriptId} (${ext}):`, err);
    patchScript(projectId, scriptId, { status: 'uploaded' });
  }
}
