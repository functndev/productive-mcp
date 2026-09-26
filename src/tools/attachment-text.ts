import { unzipSync, strFromU8 } from 'fflate';

/**
 * Text extraction for document attachments (PDF, Word, Excel, PowerPoint).
 *
 * MCP has no content block for arbitrary documents, and most clients drop or
 * mangle an embedded binary resource, so the only format every client can
 * hand to the model is text. Extraction runs here in the Worker instead.
 */

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx';

const MIME_KINDS: Record<string, DocumentKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const EXTENSION_KINDS: Record<string, DocumentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};

function extensionOf(filename: string | undefined): string {
  const match = filename?.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

/**
 * Productive sometimes stores uploads as `application/octet-stream`, so the
 * filename extension is the fallback when the MIME type is not specific.
 */
export function documentKind(
  contentType: string | undefined,
  filename: string | undefined
): DocumentKind | null {
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  if (mime && MIME_KINDS[mime]) return MIME_KINDS[mime];
  return EXTENSION_KINDS[extensionOf(filename)] ?? null;
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'ts', 'sql', 'ini', 'env', 'sh', 'svg',
]);

export function hasTextExtension(filename: string | undefined): boolean {
  return TEXT_EXTENSIONS.has(extensionOf(filename));
}

// ---- PDF ----

async function extractPdf(bytes: Uint8Array): Promise<string> {
  // Imported lazily: the bundled pdf.js is large and only needed here.
  const { getDocumentProxy, extractText } = await import('unpdf');
  // verbosity 0 keeps pdf.js font-parsing warnings out of the Worker logs.
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  // A scanned PDF has pages but no text layer.
  if (text.every(page => page.trim() === '')) return '';
  return text
    .map((page, i) => (totalPages > 1 ? `--- Page ${i + 1} ---\n${page.trim()}` : page.trim()))
    .join('\n\n');
}

// ---- Office Open XML (docx / xlsx / pptx are zipped XML) ----

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/** Numeric suffix order, so slide10 sorts after slide9. */
function byTrailingNumber(a: string, b: string): number {
  const n = (s: string) => parseInt(s.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
  return n(a) - n(b);
}

function unzipXml(bytes: Uint8Array, filter: (name: string) => boolean): Record<string, string> {
  const files = unzipSync(bytes, { filter: file => filter(file.name) });
  const out: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) out[name] = strFromU8(data);
  return out;
}

/** Collapses runs of blank lines left behind by empty paragraphs. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractDocx(bytes: Uint8Array): string {
  const files = unzipXml(bytes, name => name === 'word/document.xml');
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('Not a valid Word document (word/document.xml missing)');

  // Only <w:t> carries visible text; <w:instrText> (field codes) and
  // <w:delText> (tracked deletions) are deliberately skipped.
  let text = '';
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br[^>]*\/>|<\/w:p>/g;
  for (const m of xml.matchAll(token)) {
    if (m[1] !== undefined) text += decodeXml(m[1]);
    else if (m[0] === '<w:tab/>') text += '\t';
    else text += '\n';
  }
  return tidy(text);
}

function extractPptx(bytes: Uint8Array): string {
  const files = unzipXml(bytes, name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const slides = Object.keys(files).sort(byTrailingNumber);
  if (slides.length === 0) throw new Error('Not a valid PowerPoint file (no slides found)');

  return slides
    .map((name, i) => {
      let text = '';
      for (const m of files[name].matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>/g)) {
        text += m[1] !== undefined ? decodeXml(m[1]) : '\n';
      }
      return `--- Slide ${i + 1} ---\n${tidy(text)}`;
    })
    .join('\n\n');
}

function extractXlsx(bytes: Uint8Array): string {
  const files = unzipXml(
    bytes,
    name =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  );

  // Shared strings: one <si> per entry, possibly split into rich-text runs.
  const shared: string[] = [];
  for (const si of (files['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = '';
    for (const t of si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) s += decodeXml(t[1]);
    shared.push(s);
  }

  // Resolve sheet names to files via the workbook relationships, keeping the
  // workbook's tab order. Fall back to file order if either part is missing.
  const rels = new Map<string, string>();
  for (const r of (files['xl/_rels/workbook.xml.rels'] ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = r[0].match(/\bId="([^"]+)"/)?.[1];
    const target = r[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets: { name: string; path: string }[] = [];
  for (const s of (files['xl/workbook.xml'] ?? '').matchAll(/<sheet\b[^>]*>/g)) {
    const name = s[0].match(/\bname="([^"]*)"/)?.[1];
    const rid = s[0].match(/\br:id="([^"]+)"/)?.[1];
    const path = rid ? rels.get(rid) : undefined;
    if (name !== undefined && path && files[path]) sheets.push({ name: decodeXml(name), path });
  }
  if (sheets.length === 0) {
    Object.keys(files)
      .filter(n => n.startsWith('xl/worksheets/'))
      .sort(byTrailingNumber)
      .forEach((path, i) => sheets.push({ name: `Sheet ${i + 1}`, path }));
  }
  if (sheets.length === 0) throw new Error('Not a valid Excel file (no worksheets found)');

  return sheets
    .map(({ name, path }) => {
      const rows: string[] = [];
      for (const row of files[path].matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const body = c[2] ?? '';
          const type = attrs.match(/\bt="([^"]+)"/)?.[1];
          const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
          let value = '';
          if (type === 's' && v !== undefined) value = shared[parseInt(v, 10)] ?? '';
          else if (type === 'inlineStr') value = decodeXml(body.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/)?.[1] ?? '');
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else if (v !== undefined) value = decodeXml(v);
          cells.push(value.replace(/[\t\n]/g, ' '));
        }
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        if (cells.length) rows.push(cells.join('\t'));
      }
      return `--- Sheet: ${name} ---\n${rows.join('\n')}`;
    })
    .join('\n\n');
}

/** Returns the document's text; an empty string means it has no text layer. */
export async function extractDocumentText(
  kind: DocumentKind,
  bytes: ArrayBuffer
): Promise<string> {
  const data = new Uint8Array(bytes);
  switch (kind) {
    case 'pdf':
      return extractPdf(data);
    case 'docx':
      return extractDocx(data);
    case 'pptx':
      return extractPptx(data);
    case 'xlsx':
      return extractXlsx(data);
  }
}
