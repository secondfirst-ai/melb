import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Sources, normalizeCase, safeError, usable } from './source.mjs';
import { OfficeReader, wait } from './office-cdp.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
export const STATUSES = ['✓', '✗', '近似', '只能人看', '未核'];
const MARK = '\uE000s\\d+\uE001';
const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthPattern = months.map(m => `${m.slice(0, 3)}(?:${m.slice(3)})?`).join('|');
const words = Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((w, i) => [w, i]));
Object.assign(words, { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 });
const number = '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const decimal = s => Number(s.replaceAll(',', ''));
const quoted = () => /"([^"\n]+)"|“([^“”\n]+)”|(?<![\p{L}\p{N}])'((?:[^'\n]|(?<=\p{L})'(?=\p{L})|(?<=[sS])'(?=\s+\p{L}))+)'(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])‘((?:[^‘’\n]|(?<=\p{L})’(?=\p{L})|(?<=[sS])’(?=\s+\p{L}))+)’(?![\p{L}\p{N}])/gu;

function sentences(value) {
  const boundary = new RegExp(`[.!?]["']?(?:\\s*${MARK})*\\s+(?=[^\\s\uE000])`, 'g');
  const spans = [...value.matchAll(quoted())].map(m => [m.index, m.index + m[0].length]);
  const parts = []; let start = 0;
  for (const match of value.matchAll(boundary)) {
    const end = match.index + match[0].length;
    if (spans.some(([a, b]) => end > a && end < b)) continue;
    if (!match[0].includes('\uE000')) {
      if (!value.slice(start, match.index).includes('\uE000') && !/[A-Z0-9$“"‘']/u.test(value[end])) continue;
      if (/\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|Mr|Mrs|Dr|e\.g|i\.e)\.$/i.test(value.slice(0, match.index + 1))) continue;
    }
    parts.push(value.slice(start, end)); start = end;
  }
  parts.push(value.slice(start)); return parts;
}

export function claims(html, baseURL) {
  const parsed = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./html-claims.py', import.meta.url))], { input: html, encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BYTES, stdio: ['pipe', 'pipe', 'pipe'] }));
  const result = [];
  for (const block of parsed.blocks) {
    // 句尾的 [N] 归前一句；表格始终整行核对，不能按格拆掉引用。
    const value = normalizeCase(block.text);
    const parts = block.row ? [value] : sentences(value);
    for (const part of parts) {
      const refs = [...new Set([...part.matchAll(/\uE000(s\d+)\uE001/g)].map(m => m[1]))];
      if (!refs.length) continue;
      const text = part.replace(/\uE000s\d+\uE001/g, '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const urls = [...new Set(refs.flatMap(ref => parsed.sources[ref] ?? []).map(url => {
        try { return new URL(url, baseURL).href; } catch { return url; }
      }))];
      result.push({ text, refs, urls, missingRefs: refs.filter(ref => !parsed.sources[ref]?.length) });
    }
  }
  return result;
}

function numericTokens(text) {
  let rest = text;
  const tokens = [];
  function take(regex, make) {
    rest = rest.replace(regex, (...args) => {
      const groups = args.slice(0, -2), token = make(groups, args.at(-2));
      if (token) tokens.push({ label: groups[0].trim(), ...token });
      return token ? ' '.repeat(groups[0].length) : groups[0];
    });
  }
  const date = (day, month, year) => {
    const d = Number(day), m = Number(month), y = year ? Number(year) : null;
    if (d < 1 || d > new Date(Date.UTC(y ?? 2000, m, 0)).getUTCDate() || m < 1 || m > 12) return null;
    return { type: 'date', value: { day: d, month: m, year: y } };
  };
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, m => date(m[3], m[2], m[1]));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthPattern})\\.?(?:\\s+(\\d{4}))?\\b`, 'gi'), m => date(m[1], months.findIndex(month => month.startsWith(m[2].toLowerCase())) + 1, m[3]));
  take(new RegExp(`\\b(${monthPattern})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'), m => date(m[2], months.findIndex(month => month.startsWith(m[1].toLowerCase())) + 1, m[3]));
  // 美元先取走，不能让 US$48 / USD 48 退成普通数字、再跟澳元金额互相命中。
  take(new RegExp(`(?<![\\p{L}\\p{N}_+\\-])([+-]?)(?:US\\$|USD\\s+\\$?)\\s*(${number})(?![\\p{L}\\p{N}_]|\\.\\d)`, 'giu'), m => ({ type: 'usd', value: decimal(m[1] + m[2]) }));
  take(new RegExp(`(?<![\\p{L}\\p{N}_.+\\-])([+-]?\\$\\s*)?(${number})\\s+USD\\b`, 'giu'), m => ({ type: 'usd', value: decimal((m[1]?.trim().startsWith('-') ? '-' : '') + m[2]) }));
  // 标题里的「课程名 - $330」是分隔号；金额前紧贴的 -$330 / $-330 才带符号。
  take(new RegExp(`(?<![\\p{L}\\p{N}_+\\-])([+-]?)(?:AU?\\$|\\$|AUD\\s+\\$?)\\s*(${number})(?:\\s+AUD\\b)?(?![\\p{L}\\p{N}_]|\\.\\d)`, 'giu'), m => ({ type: 'money', value: decimal(m[1] + m[2]) }));
  take(new RegExp(`(?<![\\p{L}\\p{N}_.+\\-])(${number})\\s+AUD\\b`, 'giu'), m => ({ type: 'money', value: decimal(m[1]) }));
  take(new RegExp(`(?<![\\p{L}\\p{N}_.+\\-])(${number})\\s*(?:%|per cent\\b|percent\\b)`, 'giu'), m => ({ type: 'percent', value: decimal(m[1]) }));
  take(new RegExp(`(?<![\\p{L}\\p{N}_.+\\-])(${number})(?![\\p{L}\\p{N}_]|\\.\\d)`, 'gu'), m => ({ type: 'number', value: decimal(m[1]) }));
  // 这些 one 是习语，不是待核对的数量（例如 Microsoft, for one）。
  rest = rest.replace(/\b(?:for one|one of|one-on-one)\b/gi, s => ' '.repeat(s.length));
  const word = Object.keys(words).join('|');
  take(new RegExp(`\\b(?:${word})(?:[ -]+(?:${word}|hundred(?:\\s+and)?|thousand(?:\\s+and)?))*\\b`, 'gi'), (m, offset) => {
    if (m[0].toLowerCase() === 'one' && rest.trim().toLowerCase() !== 'one') {
      const after = rest.slice(offset + m[0].length), before = rest.slice(0, offset);
      if (!/^\s+[a-z]+/i.test(after) && !/\b(?:step|round|version|chapter|day)\s*$/i.test(before) || /^\s+(?:of|who|which|that|is|was|can|will|and|or)\b/i.test(after)) return null;
    }
    let total = 0, current = 0;
    for (const w of m[0].toLowerCase().split(/[ -]+/)) {
      if (w === 'and') continue;
      if (w === 'hundred') current *= 100;
      else if (w === 'thousand') { total += current * 1000; current = 0; }
      else current += words[w];
    }
    return { type: 'number', value: total + current };
  });
  return tokens;
}

export function tokens(text) {
  const phrases = [];
  for (const match of text.matchAll(quoted())) {
    const value = match.slice(1).find(x => x !== undefined)?.trim();
    if (value) phrases.push({ type: 'phrase', value: normalizeCase(value), label: match[0], quoted: true });
  }
  // 未加引号的设置路径也取最后一级开关名；各层菜单未必在出处中连写。
  for (const match of text.matchAll(/(?:→|›|\s>\s)\s*([^→›>|.!?\n]+)(?=$|[|.!?\n])/g)) {
    if (quoted().test(match[1])) continue;
    const value = match[1].trim().replace(/^(?:turn (?:on|off)|toggle)\s+/i, '').replace(/\s+(?:and|then)\s+(?:turn|switch|toggle|click|select|disable|enable)\b.*$/i, '');
    if (value) phrases.push({ type: 'phrase', value: normalizeCase(value), label: value });
  }
  const found = [...phrases, ...numericTokens(text)];
  return found.filter((t, i) => found.findIndex(x => x.type === t.type && JSON.stringify(x.value) === JSON.stringify(t.value)) === i);
}

function contains(text, value) {
  let at = -1;
  while ((at = text.indexOf(value, at + 1)) !== -1) {
    const before = text.slice(0, at).at(-1) ?? '', after = text[at + value.length] ?? '';
    const tail = text.slice(at + value.length), head = text.slice(0, at);
    if ((/\d$/.test(value) && /^[.,]\d/.test(tail)) || (/\d[.,]$/.test(value) && /^\d/.test(tail)) || (/^\d/.test(value) && /\d[.,]$/.test(head)) || (/^[.,]\d/.test(value) && /\d$/.test(head))) continue;
    if ((!/^[\p{L}\p{N}]/u.test(value) || !/[\p{L}\p{N}_]/u.test(before)) && (!/[\p{L}\p{N}]$/u.test(value) || !/[\p{L}\p{N}_]/u.test(after))) return true;
  }
  return false;
}
const loose = s => normalizeCase(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, (punct, offset, value) => /[.,:/+-]/.test(punct) && /\d/.test(value[offset - 1] ?? '') && /\d/.test(value[offset + 1] ?? '') ? punct : ' ').replace(/\s+/g, ' ').trim();
function matchToken(token, document) {
  if (token.type === 'phrase') {
    if (contains(document.text, token.value)) return 'exact';
    const approximate = loose(token.value);
    if (approximate && contains(loose(document.text), approximate)) return 'near';
    return 'missing';
  }
  return document.numbers.some(t => t.type === token.type && (token.type === 'date' ? t.value.day === token.value.day && t.value.month === token.value.month && (token.value.year === null || t.value.year === token.value.year) : t.value === token.value)) ? 'exact' : 'missing';
}

function sourceNumbers(text) {
  const found = numericTokens(text);
  return [...found, ...found.flatMap(t => t.type === 'date' ? Object.values(t.value).filter(value => value !== null).map(value => ({ type: 'number', value })) : t.type === 'number' ? [] : [{ type: 'number', value: t.value }])];
}

function reviewDate(text) {
  const value = text.replace(/^(?:as of|checked(?: on)?|核对于)\s*[:：]?\s*/i, '').replace(/[.!?。！？]+$/, '').trim();
  const found = numericTokens(value);
  if (found.length === 1 && found[0].type === 'date' && found[0].label === value) return true;
  const zh = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(value);
  return !!zh && numericTokens(`${zh[1]}-${zh[2].padStart(2, '0')}-${zh[3].padStart(2, '0')}`).some(t => t.type === 'date');
}

const documentFor = document => ({ ...document, text: normalizeCase(document.text), numbers: sourceNumbers(document.text) });
const documentsFor = (urls, pages) => urls.flatMap(url => [pages.get(url)?.document, pages.get(url)?.rendered].filter(Boolean));

function sourceReader() { return new Sources({ withVia: true, allowHTTP: true, preserveCase: true }); }
export async function factcheckHTML(html, { cdp = false, caller = 'factcheck', env = process.env, signal, guideURL, sources = sourceReader(), officeFactory = options => new OfficeReader(options) } = {}) {
  let office;
  try {
    if (cdp && env.GITHUB_ACTIONS) throw Error('GITHUB_ACTIONS 中拒绝 --cdp，只能本地使用');
    const rows = claims(html, guideURL);
    if (!rows.length) throw Error('指南 HTML 中没有带 #sN 引用的句子或表格行');
    const pages = new Map();
    for (const row of rows) {
      row.reviewDate = reviewDate(row.text);
      row.tokens = row.reviewDate ? [] : tokens(row.text);
    }
    for (const url of new Set(rows.filter(row => row.tokens.length).flatMap(row => row.urls))) {
      signal?.throwIfAborted();
      let document, error;
      // 抓取失败沿用显式 --cdp；HTTP 成功但缺引号原话的补核放在下面。
      try { document = await wait(sources.readHTTP(url), 120_000, signal); }
      catch (e) {
        if (signal?.aborted) throw signal.reason;
        error = safeError(e);
        if (cdp) {
          try {
            office ??= officeFactory({ caller, signal, preserveCase: true });
            document = { text: usable(await office.read(url), { preserveCase: true }), via: 'cdp' };
          }
          catch (e) { if (signal?.aborted) throw signal.reason; error += '；CDP：' + safeError(e); }
        }
      }
      if (document) {
        if (typeof document.text !== 'string' || !document.text.trim()) throw Error('出处读取器未返回正文');
        document = documentFor(document);
      }
      pages.set(url, { document, error });
    }
    const missingQuote = row => row.tokens.some(token => token.quoted && !documentsFor(row.urls, pages).some(document => matchToken(token, document) !== 'missing'));
    for (const [url, page] of pages) {
      if (!page.document || ['pdf', 'cdp'].includes(page.document.via) || !rows.some(row => row.urls.includes(url) && missingQuote(row))) continue;
      signal?.throwIfAborted();
      // 只为仍缺的引号原话读 HTML 迹象；不改 Sources/verify，也不为缺数字开浏览器。
      let dynamic = page.document.text.length < 600;
      if (!dynamic) {
        try {
          const raw = await wait(sources.readHTTP(url, { html: true }), 120_000, signal);
          dynamic = typeof raw.html === 'string' && /<(?:script|noscript)\b/i.test(raw.html);
        } catch { if (signal?.aborted) throw signal.reason; }
      }
      if (!dynamic) continue;
      page.mayNeedBrowser = true;
      if (!cdp) continue;
      try {
        office ??= officeFactory({ caller, signal, preserveCase: true });
        page.rendered = documentFor({ text: usable(await office.read(url), { preserveCase: true }), via: 'cdp' });
      } catch (e) { if (signal?.aborted) throw signal.reason; page.renderError = 'CDP：' + safeError(e); }
    }
    return rows.map(row => {
      if (!row.tokens.length) return { ...row, status: '只能人看', missing: [] };
      const documents = documentsFor(row.urls, pages);
      const outcomes = row.tokens.map(token => ({ token, matches: documents.map(document => matchToken(token, document)) }));
      const missing = outcomes.filter(o => !o.matches.some(m => m !== 'missing')).map(o => o.token.label);
      const unreadable = row.urls.filter(url => !pages.get(url)?.document || missingQuote(row) && pages.get(url)?.renderError);
      const unresolved = unreadable.length || row.missingRefs.length;
      const status = !documents.length || missing.length && unresolved ? '未核' : missing.length ? '✗' : outcomes.some(o => !o.matches.includes('exact')) ? '近似' : '✓';
      return { ...row, status, missing, unreadable, mayNeedBrowser: !cdp && missingQuote(row) && row.urls.some(url => pages.get(url)?.mayNeedBrowser), errors: unreadable.map(url => `${url}：${pages.get(url)?.renderError ?? pages.get(url)?.error ?? '没有出处正文'}`) };
    });
  } finally { try { await office?.close(); } finally { await sources.close(); } }
}

export async function checkGuide(file, options = {}) {
  const sources = options.sources ?? sourceReader();
  let html, guideURL;
  try {
    if (/^https?:\/\//i.test(file)) {
      const page = await wait(sources.readHTTP(file, { html: true }), 120_000, options.signal);
      guideURL = page.url ?? file; html = page.html;
    }
    else { if ((await fs.stat(file)).size > MAX_BYTES) throw Error('指南超过 20 MiB'); html = await fs.readFile(file, 'utf8'); }
    if (typeof html !== 'string' || !html.trim()) throw Error('指南 HTML 为空');
  } catch (e) { await sources.close(); throw Error('无法读取指南 HTML：' + safeError(e)); }
  return factcheckHTML(html, { ...options, guideURL, sources });
}

export function formatHTML(results, all = false) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, 0])), lines = [];
  for (const row of results) {
    counts[row.status]++;
    if (!all && ['✓', '只能人看'].includes(row.status)) continue;
    const detail = row.status === '✗' ? `；缺：${row.missing.join('、')}` : row.status === '未核' ? `；${[...(row.errors ?? []), ...(row.missingRefs ?? []).map(ref => `${ref} 没有出处网址`)].join('；')}` : row.status === '近似' ? '；只差大小写或标点' : row.reviewDate ? '；核对日期句，仅供人看' : '';
    lines.push(`${row.status}\t${row.text}${detail}${row.mayNeedBrowser ? '；可能要浏览器渲染' : ''}；出处：${row.urls.join('、') || '无'}`);
  }
  lines.push('汇总：' + STATUSES.map(status => `${status} ${counts[status]}`).join(' · '));
  return lines.join('\n') + '\n';
}
