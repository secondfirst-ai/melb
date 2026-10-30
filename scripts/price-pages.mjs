// 这些价格页的HTTP正文只有导航，必须显式--cdp，等可见金额渲染后再读。
export const RENDERED_PRICE_HOSTS = ['chatgpt.com', 'claude.com'];
export function renderedPricePage(url) {
  try { const host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); return RENDERED_PRICE_HOSTS.includes(host); }
  catch { return false; }
}
export const CURRENCY_AMOUNT = '(?:(?:AU?\\$|US\\$|USD|AUD|[$£€¥₹])\\s*\\d+(?:[,.]\\d+)*|\\d+(?:[,.]\\d+)*\\s*(?:AUD|USD)\\b)';
