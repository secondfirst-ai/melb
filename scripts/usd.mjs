export const USD_NOTE = 'USD 写法对上（页上写明 USD）';
const number = '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const decimal = value => Number(value.replaceAll(',', ''));
const declaration = /(?<![\p{L}\p{N}_])(?:USD(?![\p{L}\p{N}_])|US\$|US\s+dollars?(?![\p{L}\p{N}_]))/iu;
export const declaresUSD = text => declaration.test(text);

export function usdAmounts(text) {
  const result = [];
  for (const regex of [
    new RegExp(`(?<![\\p{L}\\p{N}_+\\-])([+-]?)(?:US\\$|USD\\s*\\$?)\\s*(${number})(?![\\p{L}\\p{N}_]|[.,]\\d)`, 'giu'),
    new RegExp(`(?<![\\p{L}\\p{N}_.+\\-])([+-]?\\$\\s*)?(${number})\\s*USD(?![\\p{L}\\p{N}_])`, 'giu'),
  ]) for (const match of text.matchAll(regex)) {
    if (result.some(row => match.index < row.end && match.index + match[0].length > row.start)) continue;
    const sign = match[1]?.trim().startsWith('-') ? '-' : '';
    result.push({ start: match.index, end: match.index + match[0].length, label: match[0].trim(), value: decimal(sign + match[2]) });
  }
  return result.sort((a, b) => a.start - b.start);
}

function declaredDollars(text) {
  // 词边界排除USDC等代币/单词；这个标记只在同一份出处正文生效。
  if (!declaration.test(text)) return [];
  const regex = new RegExp(`(?<![\\p{L}\\p{N}_+\\-])([+-]?)\\$\\s*(${number})(?![\\p{L}\\p{N}_]|[.,]\\d)(?!\\s*AUD\\b)`, 'giu');
  return [...text.matchAll(regex)].filter(match => !/(?<![\p{L}\p{N}_])AUD\s*$/iu.test(text.slice(0, match.index))).map(match => ({ start: match.index, end: match.index + match[0].length, value: decimal(match[1] + match[2]) }));
}

// 两条核对路径共用这个判断；显式USD只对USD，裸$还需该页声明USD。
export function usdMatch(value, text) {
  if (usdAmounts(text).some(row => row.value === value)) return 'exact';
  return declaredDollars(text).some(row => row.value === value) ? 'declared' : 'missing';
}

// 只规范美元金额；句子的其余字面仍须完整出现，不能因为价格对上就放过别的改字。
function usdLiteralSpan(quote, text, { allowDeclared = true } = {}) {
  const amounts = usdAmounts(quote);
  if (!amounts.length || amounts.some(row => usdMatch(row.value, text) === 'missing')) return null;
  const explicit = usdAmounts(text), bare = allowDeclared ? declaredDollars(text).filter(row => (typeof allowDeclared !== 'function' || allowDeclared(row)) && !explicit.some(other => row.start < other.end && row.end > other.start)) : [];
  const sources = [...explicit, ...bare];
  for (const first of sources.filter(row => row.value === amounts[0].value)) {
    const start = first.start - amounts[0].start;
    let cursor = start, previous = 0, matched = cursor >= 0;
    for (const amount of amounts) {
      const plain = quote.slice(previous, amount.start);
      if (!text.startsWith(plain, cursor)) { matched = false; break; }
      cursor += plain.length;
      const found = sources.find(row => row.start === cursor && row.value === amount.value);
      if (!found) { matched = false; break; }
      cursor = found.end; previous = amount.end;
    }
    if (matched && text.startsWith(quote.slice(previous), cursor)) return { start, end: cursor + quote.slice(previous).length };
  }
  return null;
}

export const usdLiteralMatch = (quote, text, options) => usdLiteralSpan(quote, text, options) !== null;

// 原字面可能带US$，不能再用它找摘录；保留实际命中处及页上USD声明的原文。
export function usdLiteralExcerpt(quote, text) {
  const span = usdLiteralSpan(quote, text);
  if (!span) return '';
  const start = Math.max(0, span.start - 2500), end = Math.min(text.length, span.end + 2500);
  let result = text.slice(start, end);
  const mark = declaration.exec(text);
  if (mark && (mark.index < start || mark.index + mark[0].length > end)) result += '\n…\n' + text.slice(Math.max(0, mark.index - 100), mark.index + mark[0].length + 100);
  return result;
}
