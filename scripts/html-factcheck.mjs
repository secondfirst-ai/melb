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
const number = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const decimal = s => Number(s.replaceAll(',', ''));
const quoted = () => /"([^"\n]+)"|“([^“”\n]+)”|(?<!\p{L})'([^'\n]+)'(?!\p{L})|(?<!\p{L})‘([^‘’\n]+)’(?!\p{L})/gu;

function sentences(value) {
  const boundary = new RegExp(`([.!?]["']?\\s*(?:${MARK}\\s*)*)\\s+(?=[A-Z“"])`, 'g');
  const spans = [...value.matchAll(quoted())].map(m => [m.index, m.index + m[0].length]);
  const parts = []; let start = 0;
  for (const match of value.matchAll(boundary)) {
    const end = match.index + match[0].length;
    if (spans.some(([a, b]) => end > a && end < b)) continue;
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
      if (token) tokens.push({ label: groups[0], ...token });
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
  take(new RegExp(`(?<![\\p{L}\\p{N}_])(?:AU?\\$|\\$)\\s*(${number})(?![\\p{L}\\p{N}_]|\\.\\d)`, 'giu'), m => ({ type: 'money', value: decimal(m[1]) }));
  take(new RegExp(`(?<![\\p{L}\\p{N}_.])(${number})\\s*(?:%|per cent\\b|percent\\b)`, 'giu'), m => ({ type: 'percent', value: decimal(m[1]) }));
  take(new RegExp(`(?<![\\p{L}\\p{N}_.])(${number})(?![\\p{L}\\p{N}_]|\\.\\d)`, 'gu'), m => ({ type: 'number', value: decimal(m[1]) }));
  // 这些 one 是习语，不是待核对的数量（例如 Microsoft, for one）。
  rest = rest.replace(/\b(?:for one|one of|one-on-one)\b/gi, s => ' '.repeat(s.length));
  const word = Object.keys(words).join('|');
  take(new RegExp(`\\b(?:${word})(?:[ -]+(?:${word}|hundred|thousand))*\\b`, 'gi'), (m, offset) => {
    if (m[0].toLowerCase() === 'one' && rest.trim().toLowerCase() !== 'one') {
      const after = rest.slice(offset + m[0].length), before = rest.slice(0, offset);
      if (!/^\s+[a-z]+/i.test(after) && !/\b(?:step|round|version|chapter|day)\s*$/i.test(before) || /^\s+(?:of|who|which|that|is|was|can|will|and|or)\b/i.test(after)) return null;
    }
    let total = 0, current = 0;
    for (const w of m[0].toLowerCase().split(/[ -]+/)) {
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
  let rest = text.replace(quoted(), (label, ...args) => {
    const value = args.slice(0, 4).find(x => x !== undefined)?.trim();
    if (value) phrases.push({ type: 'phrase', value: normalizeCase(value), label });
    return ' '.repeat(label.length);
  });
  // 未加引号的设置路径也取最后一级开关名；各层菜单未必在出处中连写。
  for (const match of text.matchAll(/(?:→|›|\s>\s)\s*([^→›|.!?\n]+)(?=$|[|.!?\n])/g)) {
    if (/["“”'‘’]/.test(match[1])) continue;
    const value = match[1].trim().replace(/^(?:turn (?:on|off)|toggle)\s+/i, '');
    if (value) phrases.push({ type: 'phrase', value: normalizeCase(value), label: value });
  }
  const found = [...phrases, ...numericTokens(rest)];
  return found.filter((t, i) => found.findIndex(x => x.type === t.type && JSON.stringify(x.value) === JSON.stringify(t.value)) === i);
}

function contains(text, value) {
  let at = -1;
  while ((at = text.indexOf(value, at + 1)) !== -1) {
    const before = text.slice(0, at).at(-1) ?? '', after = text[at + value.length] ?? '';
    if ((!/^[\p{L}\p{N}]/u.test(value) || !/[\p{L}\p{N}_]/u.test(before)) && (!/[\p{L}\p{N}]$/u.test(value) || !/[\p{L}\p{N}_]/u.test(after))) return true;
  }
  return false;
}
const loose = s => normalizeCase(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function matchToken(token, document) {
  if (token.type === 'phrase') {
    if (contains(document.text, token.value)) return 'exact';
    if (contains(loose(document.text), loose(token.value))) return 'near';
    return 'missing';
  }
  return document.numbers.some(t => t.type === token.type && (token.type === 'date' ? t.value.day === token.value.day && t.value.month === token.value.month && (token.value.year === null || t.value.year === token.value.year) : t.value === token.value)) ? 'exact' : 'missing';
}

function sourceReader() { return new Sources({ withVia: true, allowHTTP: true, preserveCase: true }); }
export async function factcheckHTML(html, { cdp = false, caller = 'factcheck', env = process.env, signal, guideURL, sources = sourceReader(), officeFactory = options => new OfficeReader(options) } = {}) {
  let office;
  try {
    if (cdp && env.GITHUB_ACTIONS) throw Error('GITHUB_ACTIONS 中拒绝 --cdp，只能本地使用');
    const rows = claims(html, guideURL);
    if (!rows.length) throw Error('指南 HTML 中没有带 #sN 引用的句子或表格行');
    const pages = new Map();
    for (const row of rows) row.tokens = tokens(row.text);
    for (const url of new Set(rows.filter(row => row.tokens.length).flatMap(row => row.urls))) {
      signal?.throwIfAborted();
      let document, error;
      // HTML 模式直接抓取失败才可进入显式 --cdp；不为缺词启动浏览器。
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
        document = { ...document, text: normalizeCase(document.text), numbers: numericTokens(document.text) };
      }
      pages.set(url, { document, error });
    }
    return rows.map(row => {
      if (!row.tokens.length) return { ...row, status: '只能人看', missing: [] };
      const documents = row.urls.flatMap(url => pages.get(url)?.document ? [pages.get(url).document] : []);
      const outcomes = row.tokens.map(token => ({ token, matches: documents.map(document => matchToken(token, document)) }));
      const missing = outcomes.filter(o => !o.matches.some(m => m !== 'missing')).map(o => o.token.label);
      const unreadable = row.urls.filter(url => !pages.get(url)?.document);
      const unresolved = unreadable.length || row.missingRefs.length;
      const status = !documents.length || missing.length && unresolved ? '未核' : missing.length ? '✗' : outcomes.some(o => !o.matches.includes('exact')) ? '近似' : '✓';
      return { ...row, status, missing, unreadable, errors: unreadable.map(url => `${url}：${pages.get(url)?.error ?? '没有出处正文'}`) };
    });
  } finally { try { await office?.close(); } finally { await sources.close(); } }
}

export async function checkGuide(file, options = {}) {
  const sources = options.sources ?? sourceReader();
  let html, guideURL;
  try {
    if (/^https?:\/\//i.test(file)) { guideURL = file; html = (await wait(sources.readHTTP(file, { html: true }), 120_000, options.signal)).html; }
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
    const detail = row.status === '✗' ? `；缺：${row.missing.join('、')}` : row.status === '未核' ? `；${[...(row.errors ?? []), ...(row.missingRefs ?? []).map(ref => `${ref} 没有出处网址`)].join('；')}` : row.status === '近似' ? '；只差大小写或标点' : '';
    lines.push(`${row.status}\t${row.text}${detail}；出处：${row.urls.join('、') || '无'}`);
  }
  lines.push('汇总：' + STATUSES.map(status => `${status} ${counts[status]}`).join(' · '));
  return lines.join('\n') + '\n';
}
