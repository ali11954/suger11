import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { classify } from '../../../lib/sugarTopics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 12 * 1024 * 1024;
const STORE = path.join(process.cwd(), 'data', 'drivers-upload.json');

/**
 * Sugar-specific driver scoring lives in lib/sugarTopics.ts so uploaded briefings
 * and live news are classified with the exact same taxonomy.
 */
function clean(s: string) {
  return s.replace(/\s+/g, ' ').trim();
}

function linesFrom(text: string) {
  return text
    .split(/\r?\n|[\u2022\u2023\u25aa]|(?<=[.;!?])\s{2,}/)
    .map(clean)
    .filter((l) => l.length >= 25 && l.length <= 320);
}

async function extractText(file: File, buf: Buffer) {
  const name = file.name.toLowerCase();
if (name.endsWith('.pdf') || buf.subarray(0, 4).toString() === '%PDF') {
    // Deep import avoids the debug block in pdf-parse/index.js, which would
    // otherwise try to read a non-existent test fixture at import time.
    const mod: any = await import('pdf-parse/lib/pdf-parse.js');
    const fn = mod.default ?? mod;
    const out = await fn(buf);
    return { kind: 'PDF', text: String(out?.text ?? '') };
  }
  if (name.endsWith('.docx')) {
    const mammoth: any = await import('mammoth');
    const out = await mammoth.extractRawText({ buffer: buf });
    return { kind: 'DOCX', text: String(out?.value ?? '') };
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const ExcelJS: any = (await import('exceljs')).default ?? (await import('exceljs'));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const rows: string[] = [];
    wb.eachSheet((sheet: any) => {
      rows.push(`# ${sheet.name}`);
      sheet.eachRow((row: any) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: false }, (c: any) => {
          const v = c.value;
          cells.push(typeof v === 'object' && v !== null ? String(v.text ?? v.result ?? v.richText?.map((r: any) => r.text).join('') ?? '') : String(v ?? ''));
        });
        if (cells.length) rows.push(cells.join(' | '));
      });
    });
    return { kind: 'XLSX', text: rows.join('\n') };
  }
  throw new Error('Unsupported file type. Use PDF, DOCX or XLSX.');
}

export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_UPLOAD_ENABLED !== '1') {
    return NextResponse.json(
      { error: 'Uploads are temporarily disabled: this deployment has no persistent disk.' },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data.' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: 'No file received (field name: "files").' }, { status: 400 });

  const results: any[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) {
      results.push({ file: f.name, error: `Too large (${(f.size / 1048576).toFixed(1)} MB, max 12 MB).` });
      continue;
    }
    try {
      const buf = Buffer.from(await f.arrayBuffer());
      const { kind, text } = await extractText(f, buf);
      const raw = linesFrom(text);
      const scored = raw
        .map((l) => ({ text: l, hits: classify(l) }))
        .filter((r) => r.hits.length > 0)
        .map((r) => ({
          text: r.text.slice(0, 300),
          topic: r.hits[0].topic,
          topicAr: r.hits[0].ar,
          topicEn: r.hits[0].en,
          matched: r.hits[0].terms,
          relevance: r.hits.reduce((s: number, h) => s + h.terms.length, 0),
        }))
        .sort((a, b) => b.relevance - a.relevance);

      const topics = [...new Set(scored.map((s) => s.topic))];
      results.push({
        file: f.name,
        kind,
        bytes: f.size,
        chars: text.length,
        linesScanned: raw.length,
        driversFound: scored.length,
        topics,
        items: scored.slice(0, 60),
      });
    } catch (e) {
      results.push({ file: f.name, error: e instanceof Error ? e.message : 'Parse failed' });
    }
  }

  let store: any = { updatedAt: new Date().toISOString(), items: [] };
  try {
    store = JSON.parse(await fs.readFile(STORE, 'utf8'));
  } catch {
    /* fresh */
  }

  const items = results
    .filter((r) => !r.error && r.items?.length)
    .flatMap((r) =>
      r.items.map((it: any) => ({
        ...it,
        file: r.file,
        kind: r.kind,
        origin: 'upload',
        publishedAt: new Date().toISOString(),
      })),
    );
  store.updatedAt = new Date().toISOString();
  store.files = [...(store.files ?? []), ...results.map((r) => ({ file: r.file, kind: r.kind, driversFound: r.driversFound ?? 0, error: r.error, at: new Date().toISOString() }))].slice(-40);
  store.items = [...items, ...(store.items ?? [])].slice(0, 200);
  await fs.mkdir(path.dirname(STORE), { recursive: true });
  await fs.writeFile(STORE, JSON.stringify(store, null, 2));

  return NextResponse.json({ updatedAt: store.updatedAt, results, storedItems: store.items.length });
}

