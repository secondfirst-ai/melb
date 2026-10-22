import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';

function publicIP(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address);
}
export async function publicURL(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('出处地址不是公开 https URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|lan|internal)$/.test(host)) throw Error('出处不能指向本机或私有网络');
  let timer;
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([
    lookup(host, { all: true }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DNS 超时')), 15_000); timer.unref(); }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !publicIP(address))) throw Error('出处不能指向本机或私有网络');
  return { url, addresses };
}

// 连接用刚校验的 IP，不让 HTTP 客户端重新解析 DNS；重定向留给上层逐跳处理。
export function pinnedFetch(raw, { signal, headers }, resolved, request = https.request) {
  const chosen = resolved.addresses.find((a) => a.family === 4) ?? resolved.addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(new URL(raw), {
      method: 'GET', headers, signal, agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family),
    }, (res) => {
      const noBody = [204, 205, 304].includes(res.statusCode);
      if (noBody) res.resume();
      try { resolve(new Response(noBody ? null : Readable.toWeb(res), { status: res.statusCode, headers: res.headers })); }
      catch (e) { res.destroy(); reject(e); }
    });
    req.on('error', reject); req.end();
  });
}

export async function connectTarget(authority, resolveURL = publicURL) {
  if (!/^(\[[0-9a-f:]+\]|[a-z0-9.-]+):443$/i.test(authority)) throw Error('浏览器只允许 HTTPS 443');
  const resolved = await resolveURL(`https://${authority}/`);
  return resolved.addresses.find((a) => a.family === 4) ?? resolved.addresses[0];
}

// Chromium 的 route 不覆盖同一重定向链的后续 URL。用只通公网 HTTPS 的隧道兜住所有连接；不解 TLS、不看正文。
export async function browserProxy() {
  const sockets = new Set();
  const remember = (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end('HTTPS only'); });
  server.on('connection', remember);
  server.on('connect', async (req, client, head) => {
    try {
      const target = await connectTarget(req.url);
      if (client.destroyed) return;
      const upstream = remember(net.connect({ host: target.address, family: target.family, port: 443 }));
      const timer = setTimeout(() => upstream.destroy(), 15_000);
      upstream.once('connect', () => {
        clearTimeout(timer);
        if (client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => { clearTimeout(timer); client.destroy(); });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
