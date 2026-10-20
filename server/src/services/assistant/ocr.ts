import os from 'node:os';
import path from 'node:path';

// OCR for scanned (image-only) PDFs. Pages are rendered one at a time and recognised sequentially so memory
// stays within a small free instance.
const MAX_PAGES = 10;
const SCALE = 2;
const GOOD_CONFIDENCE = 60;

async function rotate(png: Uint8Array, degrees: number): Promise<Buffer> {
  if (degrees === 0) return Buffer.from(png);
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const img = await loadImage(Buffer.from(png));
  const sideways = degrees === 90 || degrees === 270;
  const canvas = createCanvas(sideways ? img.height : img.width, sideways ? img.width : img.height);
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return canvas.toBuffer('image/png');
}

export async function ocrPdf(data: Uint8Array): Promise<string> {
  const { getDocumentProxy, renderPageAsImage } = await import('unpdf');
  const { createWorker } = await import('tesseract.js');
  const pdf = await getDocumentProxy(data.slice());
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const worker = await createWorker('eng', 1, { cachePath: path.join(os.tmpdir(), 'tessdata') });
  try {
    const out: string[] = ['(Text recognised from a scanned PDF by OCR: digits and table columns may contain errors, so say so when quoting figures.)'];
    let angle = 0;
    for (let i = 1; i <= pages; i++) {
      if (i === 1) {
        // Scans are often sideways or upside down: pick the orientation on a cheap low-resolution pass.
        const small = new Uint8Array(await renderPageAsImage(data.slice(), 1, { canvasImport: () => import('@napi-rs/canvas'), scale: 1 }));
        let bestConf = -1;
        for (const a of [0, 90, 270, 180]) {
          const r = await worker.recognize(await rotate(small, a));
          if (r.data.confidence > bestConf) { bestConf = r.data.confidence; angle = a; }
          if (a === 0 && r.data.confidence >= GOOD_CONFIDENCE) break;
        }
      }
      const png = new Uint8Array(await renderPageAsImage(data.slice(), i, { canvasImport: () => import('@napi-rs/canvas'), scale: SCALE }));
      const r = await worker.recognize(await rotate(png, angle));
      out.push(`--- Page ${i} ---\n${r.data.text}`);
    }
    if (pdf.numPages > pages) out.push(`(Only the first ${pages} of ${pdf.numPages} pages were read.)`);
    return out.join('\n\n');
  } finally {
    await worker.terminate();
  }
}
