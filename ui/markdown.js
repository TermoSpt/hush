// Small, safe Markdown renderer. Everything is HTML-escaped first; links are
// shown but never navigated to (the app is offline by design).
'use strict';

const MD = (() => {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  function inline(src) {
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<span class="md-link" title="$2">$1</span>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
    return s;
  }

  const RE = {
    fence: /^\s*(```+|~~~+)\s*([\w+#.-]*)/,
    heading: /^(#{1,6})\s+(.*)$/,
    hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s*>/,
    item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };

  const isTableStart = (line, next) => line.includes('|') && next !== undefined && RE.tableSep.test(next);
  const isBlockStart = (line, next) =>
    RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) ||
    RE.quote.test(line) || RE.item.test(line) || isTableStart(line, next);

  function codeBlock(code, lang, open) {
    return `<div class="code${open ? ' open' : ''}"><div class="code-head"><span>${esc(lang || 'text')}</span>` +
      `<button class="copy-code" type="button">Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
  }

  const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  function buildList(items) {
    let idx = 0;
    function build(level) {
      const first = items[idx];
      const tag = first.ordered ? 'ol' : 'ul';
      let s = `<${tag}${first.ordered && first.start > 1 ? ` start="${first.start}"` : ''}>`;
      while (idx < items.length && items[idx].indent >= level) {
        const it = items[idx];
        if (it.indent === level && it.ordered !== first.ordered) break;
        if (it.indent > level) {
          s = s.replace(/<\/li>$/, '') + build(it.indent) + '</li>';
          continue;
        }
        idx++;
        s += `<li>${it.text.split('\n').map(inline).join('<br>')}</li>`;
      }
      return s + `</${tag}>`;
    }
    let html = '';
    while (idx < items.length) html += build(items[idx].indent);
    return html;
  }

  function render(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if ((m = line.match(RE.fence))) {
        const marker = m[1];
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(marker)) buf.push(lines[i++]);
        const closed = i < lines.length;
        i++;
        out.push(codeBlock(buf.join('\n'), m[2], !closed));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if ((m = line.match(RE.heading))) {
        const n = Math.min(m[1].length + 1, 6); // h1 in a chat bubble is too loud
        out.push(`<h${n}>${inline(m[2])}</h${n}>`);
        i++;
        continue;
      }
      if (RE.hr.test(line)) { out.push('<hr>'); i++; continue; }
      if (RE.quote.test(line)) {
        const buf = [];
        while (i < lines.length && RE.quote.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }
      if (isTableStart(line, lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }
      if (RE.item.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const im = l.match(RE.item);
          if (im) {
            items.push({ indent: im[1].replace(/\t/g, '    ').length, ordered: /\d/.test(im[2]), start: parseInt(im[2], 10) || 1, text: im[3] });
            i++;
          } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
            items[items.length - 1].text += '\n' + l.trim();
            i++;
          } else if (!l.trim() && i + 1 < lines.length && RE.item.test(lines[i + 1])) {
            i++;
          } else break;
        }
        out.push(buildList(items));
        continue;
      }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) buf.push(lines[i++]);
      out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  return { render, esc };
})();

if (typeof module !== 'undefined') module.exports = MD;
