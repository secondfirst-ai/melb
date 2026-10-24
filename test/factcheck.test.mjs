import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { factcheck, main } from '../scripts/factcheck.mjs';
import { Sources, normalize } from '../scripts/source.mjs';
import { OfficeReader, wait } from '../scripts/office-cdp.mjs';
process.env.FACTCHECK_DRIVER_DIR=path.resolve('.cache/factcheck-drivers-'+process.pid);
after(()=>fs.rm(process.env.FACTCHECK_DRIVER_DIR,{recursive:true,force:true}));
const text='Tap water is safe. '+ 'Every drop met the guidelines. '.repeat(100);
const rows=(...urls)=>urls.map(url=>({url,quote:'Tap water is safe.'}));
const failedSources=()=>({read:async()=>({texts:[],documents:[],errors:['HTTP blocked','headless blocked']}),close:async()=>{}});
async function temporary(t){await fs.mkdir('.cache',{recursive:true});const dir=await fs.mkdtemp(path.resolve('.cache/factcheck-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function lockFixture(t,blocked=false){
 const dir=await temporary(t),script=path.join(dir,'lock.sh'),log=path.join(dir,'calls');
 await fs.writeFile(script,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${blocked?'echo "锁在 jian 手里" >&2\nexit 1':'if [ "$1" = lock ]; then echo 拿到了; else echo 放了; fi'}\n`,{mode:0o700});
 return {script,log,calls:async()=> (await fs.readFile(log,'utf8')).trim().split('\n')};
}
// 只模拟连接、自己的后台标签及浏览器里的另一张前台标签。
function fakeBrowser({mode='ok'}={}){
 const f={events:[],targets:new Map(),waiter:null,navigating:()=>{}};
 const ctx={async newCDPSession(){return {on(event,fn){f.paused=fn;},async send(method,args){f.events.push([method,args]);if(method==='Fetch.continueRequest')f.guardComplete?.(true);if(method==='Fetch.failRequest')f.guardComplete?.(false);return {};},async detach(){if(mode==='autoDetach')throw Error('Session already detached. Most likely the page has been closed.');}};},waitForEvent(_name,{predicate,signal}){return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason??Error('abort'));signal?.addEventListener('abort',abort,{once:true});
  f.waiter=async page=>{if(await predicate(page)){signal?.removeEventListener('abort',abort);resolve(page);}};
 });}};
 const session={async send(method,args){f.events.push([method,args]);
  if(method==='Target.createTarget'){
   assert.equal(args.background,true);assert.match(args.url,/^about:blank#factcheck-/);
   if(mode==='late')await new Promise(resolve=>setTimeout(resolve,35));
   const id='own-'+f.targets.size;f.targets.set(id,args.url);
   f.pageURL=args.url;const page={url:()=>f.pageURL,async goto(url){f.events.push(['goto',url]);f.navigating();if(mode==='hang')return new Promise(()=>{});if(mode==='navigation')throw Error('fake navigation failed');f.pageURL=f.finalURL??url;const allowed=await new Promise(resolve=>{f.guardComplete=resolve;f.paused({requestId:'request',request:{url:f.pageURL}});});return {ok:()=>allowed};},async evaluate(){return mode==='empty'?'short': 'Tap water is safe. '+'Every drop met the guidelines. '.repeat(100);}};
   await f.waiter({url:()=> 'https://foreign.example/existing'});await f.waiter(page);
   return {targetId:id};
  }
  if(method==='Target.closeTarget'){assert.match(args.targetId,/^own-/);f.targets.delete(args.targetId);return {success:true};}
  if(method==='Target.getTargets')return {targetInfos:[{targetId:'foreign',url:'https://foreign.example/existing'},...[...f.targets].map(([targetId,url])=>({targetId,url}))]};
  throw Error('unexpected method '+method);
 },async detach(){f.events.push(['detach']);}};
 f.browser={contexts:()=>[ctx],newBrowserCDPSession:async()=>session,async close(){f.events.push(['disconnect']);},newContext(){assert.fail('CDP 不应创建 context');}};
 return f;
}

test('本地HTTP三种状态、同URL一次HTTP、缺quote不走CDP、摘录与退出码',async t=>{
 const hits=new Map(),server=createServer((req,res)=>{hits.set(req.url,(hits.get(req.url)??0)+1);res.statusCode=req.url==='/blocked'?403:200;res.end(req.url==='/blocked'?'blocked':`<style>fake</style><p>${text}</p>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const url=`http://127.0.0.1:${server.address().port}`,input=[...rows(url+'/ok'),{url:url+'/ok',quote:'Incorrect quote'},...rows(url+'/blocked')];
 const make=()=>new Sources({withVia:true,fetchImpl:fetch,checkURL:async()=>{},browserFactory:async()=>{throw Error('fake headless blocked');}});
 const results=await factcheck(input,{sources:make()});assert.deepEqual(results.map(r=>r.status),['found','not_found','unreachable']);assert.deepEqual(results.map(r=>r.via),['curl','curl','headless']);assert.equal(hits.get('/ok'),1);assert.equal(hits.get('/blocked'),1);
 assert.equal(results[1].excerpt,normalize(text).slice(0,2500));assert.equal(results[2].excerpt,'');assert.match(results[2].error,/blocked/);
 let officeCalls=0;await factcheck(input.slice(0,2),{sources:make(),cdp:true,officeFactory(){officeCalls++;throw Error('must not use CDP');}});assert.equal(officeCalls,0);
 const output=[],summary=[];const code=await main(['-'],{stdin:Readable.from([JSON.stringify(input)]),stdout:{write:s=>output.push(s)},stderr:{write:s=>summary.push(s)},sources:make()});assert.equal(code,1);assert.equal(JSON.parse(output.join('')).length,3);assert.equal(summary.length,3);
 const found=await main(['-'],{stdin:Readable.from([JSON.stringify(input.slice(0,1))]),stdout:{write(){}},stderr:{write(){}},sources:make()});assert.equal(found,0);
});
test('JSON/CLI用法错退出2，stdin实际CLI只出JSON，CI拒CDP在所有IO之前',async()=>{
 for(const input of ['{}','[{}]','not json','[{"url":"file:///tmp/a","quote":"a"}]']){
  let out='';assert.equal(await main(['-'],{stdin:Readable.from([input]),stdout:{write:s=>out+=s},stderr:{write(){}}}),2);assert.equal(out,'');
 }
 await assert.rejects(factcheck(rows('https://example.gov.au'),{cdp:true,env:{GITHUB_ACTIONS:'1'},sources:{read(){assert.fail();}}}),/GITHUB_ACTIONS/);
 assert.throws(()=>execFileSync(process.execPath,['scripts/factcheck.mjs','missing.json','--cdp'],{env:{...process.env,GITHUB_ACTIONS:'1'},stdio:['pipe','pipe','pipe']}),e=>e.status===2&&e.stderr.toString().includes('GITHUB_ACTIONS'));
 assert.equal(execFileSync(process.execPath,['scripts/factcheck.mjs','-'],{input:'[]',env:{...process.env,GITHUB_ACTIONS:''}}).toString(),'[]\n');
});
test('headless 与 PDF via；兼容默认 Sources/literal 不增加字段',async()=>{
 const source=new Sources({withVia:true,fetchImpl:async()=>new Response('bad',{status:403}),checkURL:async()=>{}});source.readBrowser=async()=>normalize(text);
 assert.equal((await factcheck(rows('https://example.gov.au'),{sources:source}))[0].via,'headless');
 const source2=new Sources({withVia:true});source2.readHTTP=async()=>({text:normalize(text),via:'pdf'});
 assert.equal((await factcheck(rows('https://example.gov.au/file.pdf'),{sources:source2}))[0].via,'pdf');
 const legacy=new Sources();legacy.readFetch=async()=>normalize(text);assert.deepEqual(Object.keys(await legacy.read('https://example.gov.au',['Tap water is safe.'])),['texts','errors','browserFailed']);await legacy.close();
});
test('CDP批量共用锁/连接，只关自建后台target、复用同URL，断开并unlock',async t=>{
 const lock=await lockFixture(t),f=fakeBrowser();let connects=0;
 const result=await factcheck([...rows('https://example.gov.au/a','https://example.gov.au/b'),...rows('https://example.gov.au/a')],{sources:failedSources(),cdp:true,caller:'jian',officeFactory:o=>new OfficeReader({...o,lockScript:lock.script,connectImpl:async(endpoint)=>{assert.equal(endpoint,'http://127.0.0.1:9333');connects++;return f.browser;},checkURL:async()=>{}})});
 assert.deepEqual(result.map(r=>[r.status,r.via]),Array(3).fill(['found','cdp']));assert.equal(connects,1);assert.deepEqual(await lock.calls(),['lock jian factcheck','unlock jian']);assert.equal(f.events.filter(e=>e[0]==='Target.createTarget').length,2);assert.equal(f.events.filter(e=>e[0]==='Target.closeTarget').length,2);assert.equal(f.targets.size,0);assert.equal(f.events.at(-1)[0],'disconnect');
});
for(const mode of ['connection','navigation','empty','hang'])test(`CDP ${mode} 失败或超时仍unlock，自己的target都关闭`,async t=>{
 const lock=await lockFixture(t),f=fakeBrowser({mode});
 const result=await factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,officeFactory:o=>new OfficeReader({...o,lockScript:lock.script,timeout:80,checkURL:async()=>{},connectImpl:async()=>{if(mode==='connection')throw Error('fake connection failed');return f.browser;}})});
 assert.equal(result[0].status,'unreachable');assert.equal(result[0].via,'cdp');assert.deepEqual(await lock.calls(),['lock factcheck factcheck','unlock factcheck']);assert.equal(f.targets.size,0);
});
test('拿不到锁立即报owner，不连CDP也不unlock别人的锁',async t=>{
 const lock=await lockFixture(t,true);
 const result=await factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,officeFactory:o=>new OfficeReader({...o,lockScript:lock.script,checkURL:async()=>{},connectImpl:()=>assert.fail('must not connect')})});
 assert.match(result[0].error,/jian/);assert.deepEqual(await lock.calls(),['lock factcheck factcheck']);
});
test('wait成功/失败/超时/abort都结束，迟到的拒绝不成为unhandled',async()=>{
 assert.equal(await wait(Promise.resolve(3),100),3);await assert.rejects(wait(Promise.reject(Error('bad')),100),/bad/);await assert.rejects(wait(new Promise(()=>{}),5),/超时/);
 const c=new AbortController(),p=wait(new Promise(()=>{}),100,c.signal);c.abort(Error('stop'));await assert.rejects(p,/stop/);
});
test('真实子进程 SIGINT：假CDP导航中断退出130，先关闭自有target、断开、unlock',async t=>{
 const lock=await lockFixture(t),dir=path.dirname(lock.script),events=path.join(dir,'events'),fixture=path.join(dir,'sigint.mjs');
 const imports=`import assert from 'node:assert/strict';import fs from 'node:fs';import {Readable} from 'node:stream';import {main} from '${new URL('../scripts/factcheck.mjs',import.meta.url).href}';import {OfficeReader} from '${new URL('../scripts/office-cdp.mjs',import.meta.url).href}';`;
 await fs.writeFile(fixture,imports+`\nconst fakeBrowser=${fakeBrowser.toString()};const f=fakeBrowser({mode:'hang'});f.navigating=()=>process.send('navigating');const close=f.browser.close;f.browser.close=async()=>{await close();fs.writeFileSync(${JSON.stringify(events)},JSON.stringify(f.events));};\nprocess.exitCode=await main(['-','--cdp'],{stdin:Readable.from([JSON.stringify([{url:'https://example.gov.au',quote:'quote'}])]),sources:(${failedSources.toString()})(),officeFactory:o=>new OfficeReader({...o,lockScript:${JSON.stringify(lock.script)},connectImpl:async()=>f.browser,checkURL:async()=>{}})});`);
 const child=spawn(process.execPath,[fixture],{stdio:['ignore','pipe','pipe','ipc']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let stderr='';child.stderr.on('data',x=>stderr+=x);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),8000);t.after(()=>clearTimeout(timeout));
 child.on('message',msg=>{if(msg==='navigating')child.kill('SIGINT');});
 const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,130,stderr);assert.deepEqual(await lock.calls(),['lock factcheck factcheck','unlock factcheck']);const calls=JSON.parse(await fs.readFile(events,'utf8'));assert.ok(calls.some(e=>e[0]==='Target.closeTarget'));assert.equal(calls.at(-1)[0],'disconnect');
});

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('中断在途锁命令：等取得结果后 unlock，不会清理结束后才拿锁',async t=>{
 const lock=await lockFixture(t),c=new AbortController(),started=deferred(),finish=deferred(),commands=[];let completed=false;
 const run=factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,signal:c.signal,officeFactory:o=>new OfficeReader({...o,lockScript:lock.script,checkURL:async()=>{},commandImpl:async(_s,args)=>{commands.push(args);if(args[0]==='lock'){started.resolve();await finish.promise;}},connectImpl:()=>assert.fail('aborted')})});
 run.then(()=>completed=true,()=>completed=true);await started.promise;c.abort(Error('stop'));await pause(10);assert.equal(completed,false);finish.resolve();await assert.rejects(run,/stop/);assert.deepEqual(commands,[['lock','factcheck','factcheck'],['unlock','factcheck']]);
});
test('URL校验中断后不会再拿锁；关闭后的reader不可复用',async t=>{
 const lock=await lockFixture(t),c=new AbortController(),started=deferred(),finish=deferred(),commands=[];let reader;
 const run=factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,signal:c.signal,officeFactory:o=>reader=new OfficeReader({...o,lockScript:lock.script,checkURL:async()=>{started.resolve();await finish.promise;},commandImpl:async(_s,args)=>commands.push(args)})});
 await started.promise;c.abort(Error('stop'));await assert.rejects(run,/stop/);finish.resolve();await pause(10);assert.deepEqual(commands,[]);await assert.rejects(reader.start(),/stop|关闭/);
});
test('同脚本不同 reader 互斥，失败的第二个不 unlock 第一个；续租失败停止导航',async t=>{
 const lock=await lockFixture(t),commands=[];let time=0,owner;
 const commandImpl=async(_s,args)=>{commands.push(args);if(args[0]==='lock'){if(owner&&owner!==args[1])throw Error('held by '+owner);owner=args[1];}else{if(owner!==args[1])throw Error('not yours');owner=undefined;}};
 const f=fakeBrowser(),make=()=>new OfficeReader({lockScript:lock.script,commandImpl,connectImpl:async()=>f.browser,checkURL:async()=>{},now:()=>time});
 const first=make(),second=make();await first.start();await assert.rejects(second.start(),/已有 factcheck/);await second.close();assert.equal(owner,'factcheck');assert.equal(commands.length,1);
 time=6*60000;await first.read('https://example.gov.au');assert.equal(commands.filter(a=>a[0]==='lock').length,2);
 const before=f.events.filter(e=>e[0]==='goto').length;time+=61*60000;owner='wen';await assert.rejects(first.read('https://example.gov.au'),/续租失败/);assert.equal(f.events.filter(e=>e[0]==='goto').length,before);await assert.rejects(first.close(),/unlock/);assert.equal(owner,'wen');
});
test('target创建超时后迟到的确认，在断开/unlock之前收束并关闭目标',async t=>{
 const lock=await lockFixture(t),f=fakeBrowser({mode:'late'});
 const result=await factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,officeFactory:o=>new OfficeReader({...o,timeout:25,lockScript:lock.script,checkURL:async()=>{},connectImpl:async()=>f.browser})});
 assert.equal(result[0].status,'unreachable');assert.equal(f.targets.size,0);assert.equal(f.events.at(-1)[0],'disconnect');assert.deepEqual(await lock.calls(),['lock factcheck factcheck','unlock factcheck']);
});
test('CDP每跳请求在继续之前校验，拒绝私网重定向且不读取正文',async t=>{
 const lock=await lockFixture(t),f=fakeBrowser();f.finalURL='http://127.0.0.1/private';const checks=[];
 const result=await factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,officeFactory:o=>new OfficeReader({...o,lockScript:lock.script,checkURL:async url=>{checks.push(url);if(url.includes('127.0.0.1'))throw Error('private rejected');},connectImpl:async()=>f.browser})});
 assert.equal(result[0].status,'unreachable');assert.ok(checks.includes(f.finalURL));assert.ok(f.events.some(e=>e[0]==='Fetch.failRequest'));assert.ok(!f.events.some(e=>e[0]==='Fetch.continueRequest'));assert.equal(f.targets.size,0);
});
test('Sources中断后HTTP迟到，不再启动headless；默认verify分支不变',async()=>{
 const started=deferred(),finished=deferred(),c=new AbortController();let launched=0;
 const source=new Sources({withVia:true,checkURL:async()=>{},fetchImpl:async()=>{started.resolve();return finished.promise;},browserFactory:async()=>{launched++;throw Error('must not launch');}});
 const run=factcheck(rows('https://example.gov.au'),{sources:source,signal:c.signal});await started.promise;c.abort(Error('stop'));await assert.rejects(run,/stop/);finished.resolve(new Response('blocked',{status:403}));await pause(10);assert.equal(launched,0);assert.equal(source.cancel.signal.aborted,true);
});
test('HTTP公网输入显式opt-in；默认verify仍拒绝HTTP，私网始终拒绝',async()=>{
 const {publicURL}=await import('../scripts/network.mjs');
 await assert.rejects(publicURL('http://93.184.216.34/'),/公开 https/);assert.equal((await publicURL('http://93.184.216.34/',{allowHTTP:true})).url.protocol,'http:');await assert.rejects(publicURL('http://127.0.0.1/',{allowHTTP:true}),/私有/);
 const source=new Sources({withVia:true,allowHTTP:true,fetchImpl:async()=>new Response(`<p>${text}</p>`)});
 const result=await factcheck(rows('http://93.184.216.34/'),{sources:source});assert.equal(result[0].status,'found');assert.equal(result[0].via,'curl');
});
test('真实子进程 SIGINT 在锁脚本已拿锁但未返回时仍 unlock',async t=>{
 const lock=await lockFixture(t),dir=path.dirname(lock.script),ready=path.join(dir,'ready'),held=path.join(dir,'held'),file=path.join(dir,'lock-signal.mjs');
 await fs.writeFile(lock.script,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${lock.log}'\nif [ "$1" = lock ]; then touch '${held}' '${ready}'; sleep 0.3; else rm -f '${held}'; fi\nif [ "$1" = lock ]; then echo 拿到了; else echo 放了; fi\n`,{mode:0o700});
 await fs.writeFile(file,`import {Readable} from 'node:stream';import {main} from '${new URL('../scripts/factcheck.mjs',import.meta.url).href}';import {OfficeReader} from '${new URL('../scripts/office-cdp.mjs',import.meta.url).href}';process.exitCode=await main(['-','--cdp'],{stdin:Readable.from([${JSON.stringify(JSON.stringify(rows('https://example.gov.au')))}]),sources:(${failedSources.toString()})(),officeFactory:o=>new OfficeReader({...o,lockScript:${JSON.stringify(lock.script)},checkURL:async()=>{},connectImpl:()=>{throw Error('must not connect');}})});`);
 const child=spawn(process.execPath,[file],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',x=>stderr+=x);const exit=new Promise(resolve=>child.on('exit',resolve));const timer=setTimeout(()=>child.kill('SIGKILL'),8000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 for(let i=0;;i++){try{await fs.access(ready);break;}catch{assert.ok(i<1000,stderr);await pause(5);}}child.kill('SIGINT');assert.equal(await exit,130,stderr);assert.deepEqual(await lock.calls(),['lock factcheck factcheck','unlock factcheck']);await assert.rejects(fs.access(held));
});
test('已有相同caller的办公室锁不接管、不unlock',async t=>{
 const lock=await lockFixture(t),calls=[];const reader=new OfficeReader({lockScript:lock.script,commandImpl:async(_s,args)=>{calls.push(args);return '本来就是你的，续上了';},connectImpl:()=>assert.fail()});
 await assert.rejects(reader.start(),/拒绝接管同名/);await reader.close();assert.deepEqual(calls,[['lock','factcheck','factcheck']]);
});
test('两个真实子进程同caller：第二个拒绝，不放第一个锁，释放后可重跑',async t=>{
 const lock=await lockFixture(t),dir=path.dirname(lock.script),file=path.join(dir,'concurrent.mjs');
 await fs.writeFile(file,`import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {main} from '${new URL('../scripts/factcheck.mjs',import.meta.url).href}';import {OfficeReader} from '${new URL('../scripts/office-cdp.mjs',import.meta.url).href}';const fakeBrowser=${fakeBrowser.toString()};const f=fakeBrowser({mode:process.argv[2]});f.navigating=()=>process.send?.('navigating');process.exitCode=await main(['-','--cdp'],{stdin:Readable.from([${JSON.stringify(JSON.stringify(rows('https://example.gov.au')))}]),sources:(${failedSources.toString()})(),officeFactory:o=>new OfficeReader({...o,lockScript:${JSON.stringify(lock.script)},checkURL:async()=>{},connectImpl:async()=>f.browser})});`);
 const launch=mode=>{const child=spawn(process.execPath,[file,mode],{stdio:['ignore','pipe','pipe','ipc']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const done=new Promise(resolve=>child.once('exit',code=>resolve({code,out,err})));const timer=setTimeout(()=>child.kill('SIGKILL'),8000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});return {child,done};};
 const first=launch('hang');await new Promise(resolve=>first.child.on('message',msg=>{if(msg==='navigating')resolve();}));const blocked=await launch('ok').done;assert.equal(blocked.code,1,blocked.err);assert.match(JSON.parse(blocked.out)[0].error,/已有 factcheck/);assert.deepEqual(await lock.calls(),['lock factcheck factcheck']);first.child.kill('SIGINT');assert.equal((await first.done).code,130);
 const again=await launch('ok').done;assert.equal(again.code,0,again.err);assert.deepEqual(await lock.calls(),['lock factcheck factcheck','unlock factcheck','lock factcheck factcheck','unlock factcheck']);
});

test('确认自己的target已关闭后，自动detach的session不覆盖found结果',async t=>{
 const lock=await lockFixture(t),f=fakeBrowser({mode:'autoDetach'});
 const result=await factcheck(rows('https://example.gov.au'),{sources:failedSources(),cdp:true,officeFactory:o=>new OfficeReader({...o,lockScript:lock.script,checkURL:async()=>{},connectImpl:async()=>f.browser})});
 assert.equal(result[0].status,'found');assert.equal(result[0].error,undefined);assert.ok(result[0].excerpt.includes('tap water is safe.'));assert.equal(f.targets.size,0);assert.deepEqual(await lock.calls(),['lock factcheck factcheck','unlock factcheck']);
});
