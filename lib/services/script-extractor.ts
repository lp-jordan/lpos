/**
 * Shared extraction utility for script files.
 *
 * Extracts content as HTML so formatting round-trips through
 * the LPOS editor back to LeaderPrompt without loss.
 *
 * .docx → mammoth.convertToHtml  (preserves bold, italic, headings, lists)
 * .pdf  → pdf-parse plaintext wrapped in <p> paragraphs
 * .txt  → plaintext wrapped in <p> paragraphs
 *
 * The resulting HTML is stored in the sidecar file (.extracted.txt)
 * and is also used to regenerate the .docx when saving from the LPOS editor.
 */

import fs from 'node:fs';
import { patchScript, saveExtractedText } from '@/lib/store/scripts-registry';

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfMod   = await import('pdf-parse') as any;
      const pdfParse = pdfMod.default ?? pdfMod;
      const buffer   = fs.readFileSync(filePath);
      const data     = await pdfParse(buffer) as { text: string };
      html = textToHtml(data.text);
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
  } catch {
    patchScript(projectId, scriptId, { status: 'uploaded' });
  }
}
