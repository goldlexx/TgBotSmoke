import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {Database} from '../src/db.js';
import {A,parseDate,report,local,stamp} from '../src/core.js';
import {handleUpdate,DeliveryError} from '../src/bot.js';
import worker,{tick} from '../src/worker.js';

// Execute real SQLite SQL with D1's prepared/batch interface.
function database() {
  const sql=new DatabaseSync(':memory:');sql.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));
  const env={BOT_TOKEN:'123456:test',WEBHOOK_SECRET:'test-secret'};
  const statement=(query,params=[])=>({
    bind(...p){return statement(query,p);},
    async first(){return sql.prepare(query).get(...params)??null;},
    async all(){return {results:sql.prepare(query).all(...params)};},
    async run(){const r=sql.prepare(query).run(...params);return {meta:{changes:Number(r.changes)}};}
  });
  env.DB={prepare:statement,async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {env,db:new Database(env.DB),sql};
}
const now=Date.parse('2026-11-16T09:00:59Z');
const profile={daily:20,price:'250',currency:'RUB',pack:20,minutes:'5',timezone:'Europe/Moscow',report_time:'08:00',start:'2026-01-01T07:00:00+00:00'};

test('Python report parity, including medical text, Decimal, greetings and historical currencies',()=>{
  const code=`import json\nfrom datetime import UTC,datetime\nfrom smoke.stats import report\ns=[dict(start='2026-11-10T12:34:00+00:00',end='2026-11-12T13:57:00+00:00',daily=17,price='250.35',currency='RUB',pack=20,minutes='5.3'),dict(start='2026-11-13T11:00:00+00:00',end=None,daily=23,price='6.1',currency='EUR',pack=25,minutes='7.2')]\nn=datetime(2026,11,16,9,0,59,tzinfo=UTC)\nprint(json.dumps(dict(streaks=s,text=report(s,n,n.date(),42,True)),ensure_ascii=True))`;
  const python=process.platform==='win32'?'../.venv/Scripts/python.exe':'../.venv/bin/python';
  const r=spawnSync(python,['-c',code],{cwd:new URL('../',import.meta.url),env:{...process.env,PYTHONPATH:'..'},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);
  assert.equal(report(p.streaks,now,'2026-11-16',42,true),p.text);
});
test('minute accuracy, invalid dates, future, DST and zones',()=>{
  assert.equal(parseDate('Сейчас','Europe/Moscow',now),parseDate('16.11.2026 12:00','Europe/Moscow',now));
  for(const text of ['31.02.2026 10:00','01.01.1899 10:00','01.01.9999 10:00'])assert.throws(()=>parseDate(text,'Europe/Moscow',now,true));
  assert.throws(()=>parseDate('25.10.2026 02:30','Europe/Berlin',now));
  assert.throws(()=>parseDate('29.03.2026 02:30','Europe/Berlin',now));
  assert.equal(new Date(parseDate('25.10.2026 02:30 +0200','Europe/Berlin',now)).getUTCHours(),0);
  assert.equal(local(now,'Europe/Moscow').clock,'12:00');
});
test('registration, schedule updates and retry dedup',async()=>{
  const {db}=database();await db.register(1,1,profile,now);assert.equal(await db.claim(1,'2026-11-16',now),false);
  await db.register(2,2,{...profile,report_time:'13:00'},now);assert.equal(await db.one('SELECT * FROM reports WHERE user_id=2'),null);
  await db.change(2,'report_time','08:00',now);assert.equal(await db.claim(2,'2026-11-16',now),false);
  await db.run("UPDATE reports SET status='retry' WHERE user_id=2");
  await db.change(2,'timezone','Asia/Tokyo',now);assert.equal(await db.claim(2,'2026-11-16',now),true);
});
test('complete registration, lapse confirmation, all menus and settings with original texts',async()=>{
  const {db,env}=database();let seq=0;const sent=[];
  const api=async(_,method,body)=>{if(method==='sendMessage')sent.push(body.text);return true;};
  const send=async text=>handleUpdate({update_id:++seq,message:{message_id:seq,chat:{id:42,type:'private'},from:{id:42},text}},db,env,now,api);
  const cb=async data=>handleUpdate({update_id:++seq,callback_query:{id:String(seq),from:{id:42},data,message:{message_id:seq,chat:{id:42,type:'private'}}}},db,env,now,api);
  await send('/start');await send('01.01.1899 10:00');assert.equal((await db.state(42,123456)).field,'start');
  for(const text of ['01.01.2026 10:00','20','250 RUB','20','5','Europe/Moscow','08:00'])await send(text);
  assert.equal((await db.user(42)).price,'250');assert.equal((await db.state(42,123456)).state,undefined);
  for(const label of A.MENU_LABELS)await send(label);
  await cb('lapse');await send('Сейчас');await send('16.11.2026 12:00');
  const draft=await db.state(42,123456);await cb('lapse:confirm:old');assert.equal((await db.streaks(42)).length,1);
  await cb('lapse:confirm:'+draft.nonce);await cb('lapse:confirm:'+draft.nonce);assert.equal((await db.streaks(42)).length,2);
  await cb('edit:cost');await send('6 EUR');assert.equal((await db.user(42)).currency,'EUR');
  assert(sent.some(s=>s.startsWith('<b>🆘 Переживём')));assert(sent.every(s=>s.length<4096));
});
test('cron disabled until cutover, 429 retry persists, unknown delivery never repeats',async()=>{
  const {db,env}=database();await db.register(1,1,profile,now-86400000);let count=0;
  const api=async()=>{count++;if(count===1)throw new DeliveryError(429,60);};
  await tick(env,now,api);assert.equal(count,0);await db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
  await tick(env,now,api);await tick(env,now+60000,api);assert.equal(count,1);
  await db.change(1,'timezone','Asia/Tokyo',now);
  await tick(env,now+120000,api);await tick(env,now+180000,api);assert.equal(count,2);
  await tick(env,now+86400000,async()=>{count++;throw new DeliveryError(0);});
  await tick(env,now+86460000,api);assert.equal(count,3);
});
test('webhook secret, inactive gate, locks and duplicate updates',async()=>{
  const {db,env}=database();
  const request=secret=>new Request('https://example.test/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:1,message:{from:{id:42},chat:{id:42,type:'private'},text:'/start'}})});
  assert.equal((await worker.fetch(request('wrong'),env)).status,403);
  assert.equal((await worker.fetch(request('test-secret'),env)).status,503);
  assert.equal(await db.lock(42,'one',now),true);assert.equal(await db.lock(42,'two',now),false);
  await db.unlock(42,'one');assert.equal(await db.lock(42,'two',now),true);
  await db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
  await db.run('DELETE FROM user_locks');await db.run('INSERT INTO webhook_updates VALUES (?,?)',1,stamp(now));
  assert.equal((await worker.fetch(request('test-secret'),env)).status,200);
});
