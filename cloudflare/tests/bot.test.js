import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {database,now,profile} from './helpers.js';
import {A,parseDate,report,local,stamp,calculate,compactDuration,morningReport,reportButtons,healthReport,methodologyReport,milestones} from '../src/core.js';
import {handleUpdate,DeliveryError} from '../src/bot.js';
import worker,{tick} from '../src/worker.js';


test('detailed Python report parity, including medical text, Decimal and historical currencies',()=>{
  const code=`import json\nfrom datetime import UTC,datetime\nfrom smoke.stats import report\ns=[dict(start='2026-11-10T12:34:00+00:00',end='2026-11-12T13:57:00+00:00',daily=17,price='250.35',currency='RUB',pack=20,minutes='5.3'),dict(start='2026-11-13T11:00:00+00:00',end=None,daily=23,price='6.1',currency='EUR',pack=25,minutes='7.2')]\nn=datetime(2026,11,16,9,0,59,tzinfo=UTC)\nprint(json.dumps(dict(streaks=s,text=report(s,n,n.date(),42,True)),ensure_ascii=True))`;
  const python=process.platform==='win32'?'../.venv/Scripts/python.exe':'../.venv/bin/python';
  const r=spawnSync(python,['-c',code.replace('42,True','42,False')],{cwd:new URL('../',import.meta.url),env:{...process.env,PYTHONPATH:'..'},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);
  assert.equal(report(p.streaks,now,'2026-11-16',42),p.text);
});

const period=(seconds,extra={})=>({...profile,start:stamp(now-seconds*1000),...extra});

test('compact morning example, whole estimates and no medical or motivational repetition',()=>{
  const text=morningReport([period(4*86400+11*3600)],now);
  assert.equal(text,'🚭 <b>4 дня 11 часов без сигарет</b>\n\n🎯 До 7 дней — 2 дня 13 часов\n✓ Уже достигнуто: 3 дн.\nЭтап 3 → 7 дн.: ▓▓▓░░░░░░░ 36%\n\n🚬 Не выкурено: ~89 шт.\n💰 Сэкономлено: ~1 115 ₽\n⏳ Освобождено времени: ~7 ч. 25 мин.');
  assert.equal(report([period(4*86400+11*3600)],now,'2026-11-16',42,true),text);
  assert(text.length<300);
  for(const phrase of [...A.THOUGHTS,A.MODEL_NOTE,'Всего в','мин/сигарету'])assert(!text.includes(phrase));
});

test('duration omits zero parts and minutes from a day, with Russian plural forms',()=>{
  for(const [seconds,expected] of [[0,'меньше минуты'],[59,'меньше минуты'],[60,'1 мин.'],[3600,'1 ч.'],[3660,'1 ч. 1 мин.'],[86460,'1 дн.'],[90060,'1 дн. 1 ч.']])assert.equal(compactDuration(seconds),expected);
  for(const [days,expected] of [[1,'1 день'],[2,'2 дня'],[5,'5 дней'],[11,'11 дней'],[21,'21 день'],[22,'22 дня']])assert.equal(compactDuration(days*86400,true),expected);
});

test('target boundaries and multi-year progress always have ten cells and never overflow',()=>{
  for(const days of [...milestones,730,1095])for(const delta of [-1,0,1]) {
    const seconds=days*86400+delta,text=morningReport([period(seconds)],now);
    const [,cells,percent]=text.match(/([▓░]+) (\d+)%/);
    const target=Number(text.match(/До (\d+)/)[1]);
    assert.equal(cells.length,10);assert(Number(percent)>=0&&Number(percent)<100);
    assert(target*86400>seconds);
    const from=Number(text.match(/Этап (\d+)/)[1]);
    assert.equal(Number(percent),Math.floor((seconds-from*86400)/((target-from)*86400)*100));
  }
});

test('all calculations use the supplied instant and preserve Decimal precision',()=>{
  const p=period(86399,{daily:17,price:'250.35',minutes:'5.3'}),before=JSON.stringify(p);
  const a=calculate([p],now),b=calculate([p],now+1000);
  assert.equal(a.current_seconds,86399);assert.equal(b.current_seconds,86400);
  assert.equal(b.cigarettes.toString(),'17');assert.equal(b.money.RUB.toString(),'212.7975');
  assert.equal(b.free_minutes.toString(),'90.1');assert.equal(b.life_minutes.toString(),'340');
  assert.match(morningReport([p],now),/До 1 дня/);
  assert.match(morningReport([p],now+1000),/До 3 дней/);
  assert.equal(JSON.stringify(p),before);
});

test('lapse resets series and health, keeps historical totals and currencies without conversion',()=>{
  const history=period(5*86400,{end:stamp(now-3*86400000)}),active=period(3600,{currency:'EUR',price:'6.1'});
  const s=calculate([history,active],now),text=morningReport([history,active],now);
  assert.equal(s.current_seconds,3600);assert.equal(s.total_seconds,2*86400+3600);
  assert.match(text,/1 час без сигарет/);assert.match(text,/До 1 дня/);
  assert.match(text,/~41 шт\./);assert.match(text,/500 ₽ \+ 0 €/);
  assert(!healthReport(s.current_seconds).includes('✓ Примерно 48 часов'));
  assert.match(morningReport([period(0,{currency:'KZT'})],now),/~0 KZT/);
  assert(!morningReport([period(86400,{currency:'USD'})],now).includes('₽'));
});

test('health shows reached and nearest source-backed stages with preserved caveats',()=>{
  for(const sec of [0,1200,172800,315360001]) {
    const text=healthReport(sec),next=A.STAGES.find(s=>s.seconds>sec);
    for(const stage of A.STAGES.filter(s=>s.seconds<=sec))assert(text.includes('✓ '+stage.label+': '+stage.text));
    if(next)assert(text.includes(next.text)&&text.includes(next.source));
    assert(text.includes(A.HEALTH_NOTE));assert(text.length<4096);
  }
  const method=methodologyReport();assert(method.length<4096);
  for(const source of [...A.STAGES.map(s=>s.source),A.ADDICTION,A.MODEL_NOTE,A.HEALTH_NOTE])assert(method.includes(source));
  assert.match(method,/86 400/);assert.match(method,/промежутки срыва исключены/);
});

test('morning preview and real inline callbacks work during a form without altering user data',async()=>{
  const {db,env}=database();await db.register(42,42,profile,now);
  await db.saveState(42,123456,{state:'Form:value',mode:'edit',field:'daily'});
  const before=JSON.stringify({user:await db.user(42),streaks:await db.streaks(42),state:await db.state(42,123456)}),calls=[];
  const api=async(_,method,body)=>calls.push({method,body});
  await handleUpdate({message:{chat:{id:42,type:'private'},from:{id:42},text:'/morning'}},db,env,now,api);
  assert.deepEqual(calls[0].body.reply_markup,reportButtons());
  for(const button of reportButtons().inline_keyboard.flat()) {
    calls.length=0;
    await handleUpdate({callback_query:{id:'cb',from:{id:42},data:button.callback_data,message:{message_id:1,chat:{id:42,type:'private'}}}},db,env,now,api);
    assert.equal(calls[0].method,'answerCallbackQuery');assert.equal(calls[1].method,'sendMessage');
    assert(calls[1].body.text.includes(button.callback_data==='report:health'?'Ближайший ориентир':'86 400'));
  }
  assert.equal(JSON.stringify({user:await db.user(42),streaks:await db.streaks(42),state:await db.state(42,123456)}),before);
});

test('scheduled morning uses local time and inline buttons while detailed progress stays accessible',async()=>{
  const {db,env}=database();
  await db.register(1,1,{...profile,timezone:'Asia/Tokyo',report_time:'18:00'},now-86400000);
  await db.register(2,2,{...profile,timezone:'America/New_York',report_time:'08:00'},now-86400000);
  await db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
  const calls=[],api=async(_,method,body)=>calls.push({method,body});
  await tick(env,now,api);assert.equal(calls.length,1);assert.equal(calls[0].body.chat_id,1);
  assert.deepEqual(calls[0].body.reply_markup,reportButtons());
  assert.equal(calls[0].body.text,morningReport(await db.streaks(1),now));
  assert.equal((await db.one('SELECT * FROM reports WHERE user_id=1 AND local_date=?','2026-11-16')).status,'sent');
  await handleUpdate({message:{chat:{id:1,type:'private'},from:{id:1},text:A.MENU_LABELS[0]}},db,env,now,api);
  assert.match(calls.at(-1).body.text,/Всего в учтённых/);
  assert(calls.at(-1).body.reply_markup.keyboard.flat().some(b=>b.text===A.MENU_LABELS[0]));
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
  await db.change(2,'timezone','Asia/Tokyo',now);assert.equal(await db.claim(2,'2026-11-16',now),false);
});
test('complete registration, lapse confirmation, all menus and settings with original texts',async()=>{
  const {db,env}=database();let seq=0;const sent=[];
  const api=async(_,method,body)=>{if(method==='sendMessage')sent.push(body.text);return true;};
  const send=async text=>handleUpdate({update_id:++seq,message:{message_id:seq,chat:{id:42,type:'private'},from:{id:42},text}},db,env,now,api);
  const cb=async data=>handleUpdate({update_id:++seq,callback_query:{id:String(seq),from:{id:42},data,message:{message_id:seq,chat:{id:42,type:'private'}}}},db,env,now,api);
  await send('/start');await send('01.01.1899 10:00');assert.equal((await db.state(42,123456)).field,'start');
  await send('01.01.2026 10:00');await cb('register:custom:'+(await db.state(42,123456)).nonce);
  for(const text of ['20','250 RUB','20','5','Europe/Moscow','08:00'])await send(text);
  await cb('register:confirm:'+(await db.state(42,123456)).nonce);
  assert.equal((await db.user(42)).price,'250');assert.equal((await db.state(42,123456)).state,undefined);
  for(const label of A.MENU_LABELS)await send(label);
  await cb('lapse');await cb('lapse:other:'+(await db.state(42,123456)).nonce);await send('Сейчас');await send('16.11.2026 12:00');
  const draft=await db.state(42,123456);await cb('lapse:confirm:old');assert.equal((await db.streaks(42)).length,1);
  await cb('lapse:confirm:'+draft.nonce);await cb('lapse:confirm:'+draft.nonce);assert.equal((await db.streaks(42)).length,2);
  await cb('edit:cost');await send('6 EUR');assert.equal((await db.user(42)).currency,'EUR');
  assert(sent.some(s=>s.startsWith('<b>🆘 Переживём')));assert(sent.every(s=>s.length<4096));
});
test('cron disabled until cutover, 429 and timeout retries are bounded',async()=>{
  const {db,env}=database();await db.register(1,1,profile,now-86400000);let count=0;
  const api=async()=>{count++;if(count===1)throw new DeliveryError(429,60);};
  await tick(env,now,api);assert.equal(count,0);await db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
  await tick(env,now,api);await tick(env,now+60000,api);assert.equal(count,1);
  await tick(env,now+120000,api);await tick(env,now+180000,api);assert.equal(count,2);
  await tick(env,now+86400000,async()=>{count++;throw new DeliveryError(0);});
  await tick(env,now+86460000,api);assert.equal(count,4);
});
test('webhook secret, inactive gate, locks and duplicate updates',async()=>{
  const {db,env}=database();
  const request=secret=>new Request('https://example.test/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify({update_id:1,message:{date:Math.floor(Date.now()/1000),from:{id:42},chat:{id:42,type:'private'},text:'/start'}})});
  assert.equal((await worker.fetch(request('wrong'),env)).status,403);
  assert.equal((await worker.fetch(request('test-secret'),env)).status,503);
  assert.equal(await db.lock(42,'one',now),true);assert.equal(await db.lock(42,'two',now),false);
  await db.unlock(42,'one');assert.equal(await db.lock(42,'two',now),true);
  await db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
  await db.run('DELETE FROM user_locks');await db.run('INSERT INTO webhook_updates(update_id,created_at) VALUES (?,?)',1,stamp(now));
  assert.equal((await worker.fetch(request('test-secret'),env)).status,200);
});
