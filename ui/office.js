// Reads the text out of Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files.
// These are zip archives of XML; we unzip with the browser's built-in
// DecompressionStream, so no libraries and nothing leaves the app.
'use strict';

const Office = (() => {
  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Minimal zip reader: uses the central directory, supports "stored" and "deflate".
  function listZip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid Office file (no zip directory found).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
      entries[name] = { method, compSize, localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntry(buf, entry) {
    const dv = new DataView(buf);
    const o = entry.localOffset;
    const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    const data = new Uint8Array(buf, start, entry.compSize);
    const raw = entry.method === 0 ? data : entry.method === 8 ? await inflateRaw(data) : null;
    if (!raw) throw new Error('Unsupported compression in this file.');
    return new TextDecoder().decode(raw);
  }

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] !== undefined ? ENT[e] : m;
  });
  const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ''));

  function docxText(xml) {
    // Tables become "| a | b |" rows so the model can read them.
    const withTables = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
      const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [])
        .map((c) => c.replace(/<\/w:p>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      return `<w:p>| ${cells.join(' | ')} |</w:p>`;
    });
    const body = withTables
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t');
    return stripTags(body).replace(/\n{3,}/g, '\n\n').trim();
  }

  function slideText(xml) {
    const paras = xml.split(/<\/a:p>/).map((p) => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => stripTags(t)).join('')).filter((t) => t.trim());
    return paras.join('\n');
  }

  const colIndex = (ref) => {
    const letters = ref.replace(/\d+/g, '');
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  function sheetCsv(xml, shared) {
    const rows = [];
    for (const rowXml of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const c of rowXml.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) || []) {
        const ref = (c.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const type = (c.match(/\bt="(\w+)"/) || [])[1];
        let v = '';
        if (type === 'inlineStr') v = stripTags((c.match(/<is>([\s\S]*?)<\/is>/) || ['', ''])[1]);
        else {
          const raw = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (raw !== undefined) v = type === 's' ? shared[Number(raw)] || '' : decode(raw);
        }
        cells[ref ? colIndex(ref) : cells.length] = csvCell(v);
      }
      rows.push(Array.from(cells, (x) => x || '').join(','));
    }
    while (rows.length && !rows[rows.length - 1].replace(/,/g, '')) rows.pop();
    return rows.join('\n');
  }

  async function extract(file) {
    const buf = await file.arrayBuffer();
    const zip = listZip(buf);
    const ext = (file.name.match(/\.(\w+)$/) || [])[1].toLowerCase();
    if (ext === 'docx') {
      if (!zip['word/document.xml']) throw new Error('No document text found.');
      return docxText(await readEntry(buf, zip['word/document.xml']));
    }
    if (ext === 'pptx') {
      const slides = Object.keys(zip).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
      const out = [];
      for (let i = 0; i < slides.length; i++) out.push(`--- Slide ${i + 1} ---\n${slideText(await readEntry(buf, zip[slides[i]]))}`);
      return out.join('\n\n');
    }
    if (ext === 'xlsx') {
      const shared = zip['xl/sharedStrings.xml']
        ? ((await readEntry(buf, zip['xl/sharedStrings.xml'])).match(/<si>[\s\S]*?<\/si>/g) || []).map(stripTags)
        : [];
      const names = [];
      if (zip['xl/workbook.xml']) {
        const wb = await readEntry(buf, zip['xl/workbook.xml']);
        for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)) names.push(decode(m[1]));
      }
      const sheets = Object.keys(zip).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .sort((a, b) => parseInt(a.match(/sheet(\d+)/)[1], 10) - parseInt(b.match(/sheet(\d+)/)[1], 10));
      const out = [];
      for (let i = 0; i < sheets.length; i++) out.push(`--- Sheet: ${names[i] || i + 1} (CSV) ---\n${sheetCsv(await readEntry(buf, zip[sheets[i]]), shared)}`);
      return out.join('\n\n');
    }
    throw new Error('Unsupported Office format.');
  }

  return { extract, docxText, slideText, sheetCsv };
})();

if (typeof module !== 'undefined') module.exports = Office;
