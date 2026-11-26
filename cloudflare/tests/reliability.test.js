import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {database,now,profile,request,message,callback} from './helpers.js';
import worker,{webhook,tick,TICK_LIMIT,deliveryResult} from '../src/worker.js';
import {nextDue,dayDue,local,stamp} from '../src/core.js';
import {DeliveryError} from '../src/bot.js';
import {Temporal} from '@js-temporal/polyfill';
const active=db=>db.run("UPDATE cloud_control SET value='1' WHERE key='active'");

test('/admin fails closed before querying D1',async()=>{
  const {env,metrics}=database();
  const admin=message(501,501,'/admin');
  const api=()=>assert.fail('Unexpected Telegram reply');
  for(const owner of [undefined,'','invalid','0501','501.0','+501','900','-501',501]) {
    assert.equal((await webhook(request(admin),{...env,OWNER_CHAT_ID:owner},now,api)).status,200);
  }
  env.OWNER_CHAT_ID='501';
  const group={...admin,message:{...admin.message,chat:{id:-601,type:'group'}}};
  const mismatchedSender={...admin,message:{...admin.message,from:{id:502,username:'owner'}}};
  for(const update of [group,mismatchedSender,message(502,502,'/admin')]) {
    assert.equal((await webhook(request(update),env,now,api)).status,200);
  }
  assert.equal((await webhook(request(admin,'wrong'),env,now,api)).status,403);
  assert.equal(metrics.calls,0);
});

test('/admin counts registered subscriptions and scheduler eligibility without changing personal data',async()=>{
  const {db,env,sql,metrics}=database();
  env.OWNER_CHAT_ID='510';
  const replies=[];
  const api=async(_,method,body)=>{assert.equal(method,'sendMessage');assert.equal(body.chat_id,510);replies.push(body);};
  const send=(seq,text,time=now)=>webhook(request(message(510,seq,text,time)),env,time,api);
  assert.equal((await send(510,'/admin')).status,503);
  await active(db);
  assert.equal((await send(510,'/admin')).status,200);
  const expected=(total,subscribed)=>[
    '📊 <b>Статистика бота</b>','',`👥 Пользователей в базе: ${total}`,
    `✅ Завершили регистрацию: ${total}`,`🔔 Включили уведомления: ${subscribed}`,
    `📨 Могут получать автоматические отчёты: ${subscribed}`
  ].join('\n');
  assert.equal(replies[0].text,expected(0,0));
  for(const id of [510,511,512,513])await db.register(id,id,profile,now);
  await db.notifications(512,false,now);
  await db.run('UPDATE users SET next_due_at=NULL WHERE user_id=511');
  await db.run('UPDATE users SET next_due_at=? WHERE user_id=510',now-1);
  await db.saveState(510,123456,{state:'start',mode:'edit'});
  await db.saveState(999,123456,{state:'start',mode:'register'});
  const snapshot=()=>['users','fsm','streaks','achievements','reports','report_retries'].map(table=>sql.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all());
  const before=snapshot();
  metrics.sql.length=0;
  assert.equal((await send(511,'/admin@SmokeTestBot')).status,200);
  assert.equal(replies[1].text,expected(4,3));
  assert.equal(replies[1].parse_mode,'HTML');
  assert(!metrics.sql.some(query=>/SELECT \* FROM (users|fsm|streaks|reports|achievements)/.test(query)));
  assert.equal((await send(511,'/admin@SmokeTestBot')).status,200);
  assert.equal(replies.length,2);
  assert.deepEqual(snapshot(),before);
  await tick(env,now,async()=>{});
  assert((await db.user(511)).next_due_at>now);
  assert.equal((await db.user(512)).next_due_at,null);
  assert.equal((await send(512,'/admin')).status,200);
  assert.equal(replies[2].text,expected(4,3));
});

test('/admin warns only starting at 200 registered users',async()=>{
  const {db,env,sql}=database();
  await active(db);env.OWNER_CHAT_ID='520';
  const insert=sql.prepare("INSERT INTO users(user_id,chat_id,daily,price,currency,pack,minutes,timezone,report_time,enabled) VALUES (?, ?,20,'250','RUB',20,'5','UTC','08:00',0)");
  for(let id=1;id<=199;id++)insert.run(id,id);
  const replies=[];
  const api=async(_,method,body)=>{assert.equal(method,'sendMessage');replies.push(body.text);};
  await webhook(request(message(520,520,'/admin')),env,now,api);
  insert.run(200,200);
  await webhook(request(message(520,521,'/admin')),env,now,api);
  assert.match(replies[0],/Завершили регистрацию: 199/);
  assert.doesNotMatch(replies[0],/пропускную способность/);
  assert.match(replies[1],/Завершили регистрацию: 200/);
  assert.match(replies[1],/⚠️ Пора проверить пропускную способность рассылки\.$/);
});

test('additive migration preserves legacy rows and foreign keys',async()=>{
  const {sql}=database({legacy:true});
  sql.exec("INSERT INTO users VALUES(1,1,20,'250','RUB',20,'5','Europe/Moscow','08:00',1); INSERT INTO streaks VALUES(1,1,'2026-01-01',NULL,20,'250','RUB',20,'5'); INSERT INTO reports VALUES(1,'2026-11-15','sent','2026-11-15'); INSERT INTO webhook_updates VALUES(5,'2026-11-15')");
  const before=JSON.stringify(sql.prepare('SELECT * FROM streaks').all());
  sql.exec(readFileSync(new URL('../migrations/0002_reliability.sql',import.meta.url),'utf8'));
  assert.equal(JSON.stringify(sql.prepare('SELECT * FROM streaks').all()),before);
  sql.exec(readFileSync(new URL('../migrations/0003_motivation.sql',import.meta.url),'utf8'));
  assert.equal(JSON.stringify(sql.prepare('SELECT * FROM streaks').all().map(({lapse_count,...row})=>{
    assert.equal(lapse_count,null);return row;
  })),before);
  assert.equal(sql.prepare('SELECT count(*) n FROM users').get().n,1);
  assert.equal(sql.prepare('SELECT status FROM reports').get().status,'sent');
  assert.equal(sql.prepare('PRAGMA foreign_key_check').all().length,0);
  for(const query of ["SELECT * FROM users WHERE enabled=1 AND next_due_at<=0 ORDER BY next_due_at,user_id LIMIT 8","SELECT update_id FROM webhook_updates WHERE created_at<'2026' ORDER BY created_at LIMIT 200"]) {
    const plan=sql.prepare('EXPLAIN QUERY PLAN '+query).all().map(p=>p.detail).join(' ');
    assert.match(plan,/USING (?:COVERING )?INDEX/);assert(!/SCAN users/.test(plan));
  }
});
test('internal delivery requires the secret and rejects invalid task payloads',async()=>{
  const {env}=database();
  const req=(body,secret='wrong')=>new Request('https://example.test/internal/delivery',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':secret},body});
  assert.equal((await worker.fetch(req('{}'),env)).status,403);
  assert.equal((await worker.fetch(req('{','test-secret'),env)).status,400);
  assert.equal((await worker.fetch(req('{"kind":"x","id":1}','test-secret'),env)).status,400);
  assert.equal((await worker.fetch(req('x'.repeat(1025),'test-secret'),env)).status,413);
});
test('UTC schedule handles spring gaps, autumn overlaps and 23/25-hour days',()=>{
  assert.equal(new Date(dayDue('2026-03-29','Europe/Berlin','02:30')).toISOString(),'2026-03-29T01:30:00.000Z');
  assert.equal(new Date(dayDue('2026-10-25','Europe/Berlin','02:30')).toISOString(),'2026-10-25T00:30:00.000Z');
  for(const [before,after,hours] of [['2026-03-28','2026-03-29',23],['2026-10-24','2026-10-25',25]])
    assert.equal((dayDue(after,'Europe/Berlin','08:00')-dayDue(before,'Europe/Berlin','08:00'))/3600000,hours);
  const first=dayDue('2026-10-25','Europe/Berlin','02:30');
  assert.equal(local(nextDue(first,'Europe/Berlin','02:30','2026-10-25'),'Europe/Berlin').day,'2026-10-26');
});
test('native scheduling agrees with Temporal for DST, fractional offsets and date-line gaps',()=>{
  for(const zone of ['Europe/Berlin','America/New_York','Australia/Lord_Howe','Pacific/Chatham','Asia/Kathmandu','Pacific/Apia'])
    for(const day of ['2026-03-29','2026-04-05','2026-10-25','2026-11-01','2011-12-30'])
      for(const clock of ['01:30','02:15','02:30','08:00']) {
        const [hour,minute]=clock.split(':').map(Number);
        const expected=Number(Temporal.PlainDate.from(day).toPlainDateTime({hour,minute}).toZonedDateTime(zone,{disambiguation:'compatible'}).epochMilliseconds);
        assert.equal(dayDue(day,zone,clock),expected,`${zone} ${day} ${clock}`);
      }
});
test('atomic action rollback and redelivery do not advance FSM or lose update',async()=>{
  const {db,env,sql}=database();await active(db);const calls=[];
  const batch=env.DB.batch;let fail=true;
  env.DB.batch=async ss=>{if(fail&&ss.some(s=>s.query.startsWith('INSERT INTO webhook_updates'))){fail=false;throw Error('Injected commit failure');}return batch(ss);};
  const u=message(101,1001,'/start'),api=async(...args)=>calls.push(args);
  assert.equal((await webhook(request(u),env,now,api)).status,503);
  assert.equal((await db.state(101,123456)).state,undefined);
  assert.equal(sql.prepare('SELECT count(*) n FROM webhook_updates').get().n,0);
  assert.equal(sql.prepare('SELECT count(*) n FROM user_locks').get().n,0);
  assert.equal((await webhook(request(u),env,now,api)).status,200);
  const state=JSON.stringify(await db.state(101,123456)),count=calls.length;
  assert.equal((await webhook(request(u),env,now,api)).status,200);
  assert.equal(calls.length,count);assert.equal(JSON.stringify(await db.state(101,123456)),state);
});
test('outbox survives 5xx; duplicate webhook never repeats business action or successful replies',async()=>{
  const {db,env,sql}=database();await active(db);await db.register(102,102,profile,now);
  let sends=0;const api=async(_,method)=>{if(method==='sendMessage'&&++sends===1)throw new DeliveryError(503);};
  const u=message(102,1002,'/privacy');
  await webhook(request(u),env,now,api);assert.equal(sends,1);
  await webhook(request(u),env,now,api);assert.equal(sends,1);
  assert.equal(sql.prepare('SELECT attempts FROM delivery_outbox').get().attempts,1);
  await tick(env,now+60000,api);await tick(env,now+120000,api);
  assert.equal(sends,2);assert.equal(sql.prepare('SELECT count(*) n FROM delivery_outbox').get().n,0);
});
test('expired answerCallbackQuery does not block setting changes; /start preserves opt-out',async()=>{
  const {db,env}=database();await active(db);await db.register(103,103,profile,now);
  const api=async(_,method)=>{if(method==='answerCallbackQuery')throw new DeliveryError(400);};
  const click=(seq,action,time=now)=>webhook(request(callback(103,seq,action,time)),env,time,api);
  await click(10031,'notifications');
  assert.equal((await click(1003,`f:${(await db.state(103,123456)).nonce}:off`)).status,200);
  assert.equal((await db.user(103)).enabled,0);assert.equal((await db.user(103)).next_due_at,null);
  await webhook(request(message(103,1004,'/start')),env,now+11000,api);assert.equal((await db.user(103)).enabled,0);
  await click(1005,'notify:on',now+22000);
  await click(10051,`f:${(await db.state(103,123456)).nonce}:v06:00`,now+22000);
  assert.equal((await db.user(103)).enabled,1);assert((await db.user(103)).next_due_at>now);
});
test('delete erases related data, cancels pending replies and rejects old events after fresh /start',async()=>{
  const {db,env,sql}=database();await active(db);await db.register(104,104,profile,now-86400000);
  const api=async()=>{};
  await webhook(request(message(104,1006,'/delete')),env,now,api);
  const draft=await db.state(104,123456);
  assert(await db.user(104));
  await db.run("INSERT INTO delivery_outbox(update_id,user_id,sequence,method,body,due_at,created_at) VALUES(9,104,0,'sendMessage','{}',?,?)",now+60000,now);
  await webhook(request(callback(104,1007,'delete:confirm:'+draft.nonce,now+11000)),env,now+11000,api);
  for(const t of ['users','streaks','achievements','reports','report_retries','delivery_outbox','user_locks','rate_limits','fsm'])assert.equal(sql.prepare('SELECT count(*) n FROM '+t).get().n,0,t);
  assert.equal(sql.prepare('SELECT count(*) n FROM deleted_accounts').get().n,1);
  await webhook(request(message(104,1008,'/start',now)),env,now+22000,api);
  assert.equal((await db.state(104,123456)).state,undefined);
  await webhook(request(message(104,1009,'/start',now+33000)),env,now+33000,api);
  assert.equal((await db.state(104,123456)).state,'Form:welcome');
  await webhook(request(callback(104,1010,'lapse',now)),env,now+44000,api);
  assert.equal((await db.state(104,123456)).state,'Form:welcome');
  assert.equal(await db.user(104),null);
});

test('webhook onboarding updates /admin counts only after opt-in and deduplicates report setup',async()=>{
  const {db,env}=database();await active(db);env.OWNER_CHAT_ID='701';
  let seq=700,time=now;
  const replies=[];
  const api=async(_,method,body)=>{if(method==='sendMessage')replies.push(body);};
  const send=async(id,text)=>{
    time+=11000;
    assert.equal((await webhook(request(message(id,++seq,text,time)),env,time,api)).status,200);
  };
  const cb=async action=>{
    time+=11000;
    const update=callback(700,++seq,action,time);
    assert.equal((await webhook(request(update),env,time,api)).status,200);
    return update;
  };
  await send(700,'/start');
  await cb(`f:${(await db.state(700,123456)).nonce}:begin`);
  for(const value of ['Сейчас','10','250','Europe/Moscow'])await send(700,value);
  const profileBefore=await db.user(700);
  assert.equal(profileBefore.enabled,0);assert.equal(profileBefore.next_due_at,null);
  assert.equal(await db.one('SELECT 1 FROM reports WHERE user_id=700'),null);
  await send(701,'/admin');
  assert.match(replies.at(-1).text,/Завершили регистрацию: 1\n🔔 Включили уведомления: 0\n📨 Могут получать автоматические отчёты: 0/);
  const select=`f:${(await db.state(700,123456)).nonce}:v06:00`;
  const update=await cb(select);
  assert.match(replies.at(-1).text,/Ежедневный отчёт подключён/);
  const optedIn=await db.user(700);
  assert.deepEqual({...optedIn},{...profileBefore,enabled:1,report_time:'06:00',next_due_at:nextDue(time,'Europe/Moscow','06:00')});
  const count=replies.length;
  assert.equal((await webhook(request(update),env,time,api)).status,200);
  assert.equal(replies.length,count);
  await cb(select);
  assert.match(replies.at(-1).text,/устарела/);
  assert.deepEqual(await db.user(700),optedIn);
  await send(701,'/admin');
  assert.match(replies.at(-1).text,/Завершили регистрацию: 1\n🔔 Включили уведомления: 1\n📨 Могут получать автоматические отчёты: 1/);
});
test('confirmed lapse is idempotent across Telegram redeliveries and distinct duplicate callbacks',async()=>{
  const {db,env}=database();await active(db);await db.register(105,105,profile,now-86400000);const api=async()=>{};
  await webhook(request(callback(105,1011,'lapse')),env,now,api);
  const choice=(await db.state(105,123456)).nonce;
  await webhook(request(callback(105,1012,'lapse:now:'+choice,now+11000)),env,now+11000,api);
  assert.equal((await db.streaks(105)).length,1);
  const nonce=(await db.state(105,123456)).nonce,u=callback(105,1013,'lapse:confirm:'+nonce,now+22000);
  await webhook(request(u),env,now+22000,api);await webhook(request(u),env,now+33000,api);
  await webhook(request(callback(105,1014,'lapse:confirm:'+nonce,now+44000)),env,now+44000,api);
  assert.equal((await db.streaks(105)).length,2);
  assert.equal((await db.streaks(105))[0].lapse_count,1);
});

test('a milestone is celebrated at the first morning after reaching it and once across series',async()=>{
  const {db,env}=database();await active(db);
  const start=stamp(now-7*86400000-6*3600000);
  await db.register(110,110,{...profile,start},now-86400000);
  const sent=[],api=async(_,method,body)=>sent.push(body.text);
  await tick(env,now,api);await tick(env,now,api);
  assert.equal(sent.length,1);
  assert.match(sent[0],/Целая неделя без сигарет!/);
  assert.match(sent[0],/Факт дня/);
  assert.match(sent[0],/Следующая цель — 14 дней/);
  const [old]=await db.streaks(110);
  await db.lapse(110,old.id,stamp(now),stamp(now),now,1);
  await tick(env,now+7*86400000+1000,api);
  assert.equal(sent.length,2);
  assert(!sent[1].includes('🏆'));
  assert.equal((await db.one('SELECT count(*) AS n FROM reports WHERE milestone=7')).n,1);
});

test('ambiguous delivery retries the report without the milestone; 429 can still celebrate',async()=>{
  for(const code of [0,429]) {
    const {db,env}=database();await active(db);
    await db.register(111,111,{...profile,start:stamp(now-86400000)},now-86400000);
    const sent=[],api=async(_,method,body)=>{sent.push(body.text);if(sent.length===1)throw new DeliveryError(code);};
    await tick(env,now,api);await tick(env,now+60000,api);
    assert.equal(sent.length,2);
    assert.match(sent[0],/Первый день без сигарет!/);
    assert.equal(sent[1].includes('🏆'),code===429);
    assert.equal((await db.one('SELECT milestone,status FROM reports WHERE milestone=1')).status,'sent');
  }
});
test('two ambiguous attempts are the maximum, including lost final commit',async()=>{
  const {db,env,sql}=database();await active(db);await db.register(106,106,profile,now-86400000);
  let calls=0;const api=async()=>{calls++;throw new DeliveryError(0);};
  for(let n=0;n<10;n++)await tick(env,now+n*60000,api);
  assert.equal(calls,2);assert.equal(sql.prepare('SELECT attempts FROM reports WHERE status=\'unknown\'').get().attempts,2);
  assert.equal(deliveryResult(new DeliveryError(429,5),4,now).retry,0);
});
test('a crash after Telegram accepts a report recovers once and never loops',async()=>{
  const {db,env}=database();await active(db);await db.register(108,108,profile,now-86400000);
  const batch=env.DB.batch;let fail=true,calls=0;
  env.DB.batch=async ss=>{if(fail&&ss.some(s=>s.query.startsWith('UPDATE reports SET status'))){fail=false;throw Error('Lost finish');}return batch(ss);};
  const api=async()=>{calls++;};
  await assert.rejects(()=>tick(env,now,api));
  await tick(env,now+60000,api);assert.equal(calls,1);
  await tick(env,now+121000,api);await tick(env,now+240000,api);assert.equal(calls,2);
});
test('spam is bounded before most D1 work and distributed window admits at most 12/min',async()=>{
  const {db,env,metrics,sql}=database();await active(db);const api=async()=>{};
  for(let i=0;i<40;i++)await webhook(request(message(107,2000+i,'/privacy')),env,now,api);
  assert.equal(sql.prepare('SELECT count(*) n FROM webhook_updates').get().n,8);
  const before=metrics.calls;
  for(let i=0;i<40;i++)await webhook(request(message(107,2100+i,'/privacy')),env,now,api);
  assert.equal(metrics.calls-before,0); // rejected before D1, including active gate
});
test('200 synthetic users: concurrent Cron, same due time, multiple zones, bounded budgets',async()=>{
  const {db,env,metrics,sql}=database();await active(db);
  const instant=Date.parse('2026-10-25T00:30:00Z'),zones=['Europe/Berlin','America/New_York','Asia/Tokyo','Asia/Kolkata','Pacific/Auckland','Australia/Sydney','UTC','Europe/Moscow'];
  for(let i=1;i<=200;i++) {
    const timezone=zones[i%zones.length],report_time=local(instant,timezone).clock;
    await db.register(i,i,{...profile,timezone,report_time},instant-86400000);
    await db.run('UPDATE users SET next_due_at=? WHERE user_id=?',instant,i);
  }
  const delivered=new Map(),latencies=[];let virtual=instant,maxCalls=0,maxExternal=0;
  const api=async(_,method,body)=>{assert.equal(method,'sendMessage');delivered.set(body.chat_id,(delivered.get(body.chat_id)||0)+1);latencies.push((virtual-instant)/60000);};
  const started=performance.now();
  for(let n=0;n<Math.ceil(200/TICK_LIMIT);n++) {
    virtual=instant+n*60000;const before=metrics.calls,count=latencies.length;
    await tick(env,virtual,api);
    maxCalls=Math.max(maxCalls,metrics.calls-before);maxExternal=Math.max(maxExternal,latencies.length-count);
  }
  assert.equal(delivered.size,200);assert([...delivered.values()].every(n=>n===1));
  assert(maxCalls+maxExternal<=50);assert(maxCalls<=50);
  // Concurrent runs after a daily reset contend on the same due users.
  await db.run('DELETE FROM reports');await db.run('UPDATE users SET next_due_at=?',instant);delivered.clear();
  await Promise.all([tick(env,instant,api),tick(env,instant,api)]);
  assert([...delivered.values()].every(n=>n===1));
  assert.equal(sql.prepare('PRAGMA foreign_key_check').all().length,0);
  console.log(JSON.stringify({measurement:'local SQLite; not Cloudflare CPU/row metrics',users:200,ticks:25,max_d1_calls:maxCalls,max_external:maxExternal,max_virtual_delay_minutes:Math.max(...latencies),local_wall_ms:Math.round(performance.now()-started)}));
});
