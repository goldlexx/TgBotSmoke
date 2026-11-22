import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {database,now,profile,message,callback} from './helpers.js';
import {A,parseDate,local,stamp,calculate,compactDuration,morningReport,reportButtons,healthReport,methodologyReport,milestones} from '../src/core.js';
import {dailyFact,stages} from '../src/health.js';
import {handleUpdate,DeliveryError} from '../src/bot.js';
import worker,{tick} from '../src/worker.js';


test('statistics match Python, with Decimal precision and historical currencies',()=>{
  const code=`import json\nfrom datetime import UTC,datetime\nfrom smoke.stats import calculate\ns=[dict(start='2026-11-10T12:34:00+00:00',end='2026-11-12T13:57:00+00:00',daily=17,price='250.35',currency='RUB',pack=20,minutes='5.3'),dict(start='2026-11-13T11:00:00+00:00',end=None,daily=23,price='6.1',currency='EUR',pack=25,minutes='7.2')]\nn=datetime(2026,11,16,9,0,59,tzinfo=UTC)\na=calculate(s,n)\nprint(json.dumps(dict(streaks=s,stats=dict(vars(a),life_minutes=a.life_minutes)),default=str))`;
  const python=process.platform==='win32'?'../.venv/Scripts/python.exe':'../.venv/bin/python';
  const r=spawnSync(python,['-c',code],{cwd:new URL('../',import.meta.url),env:{...process.env,PYTHONPATH:'..'},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const p=JSON.parse(r.stdout);
  const s=calculate(p.streaks,now);
  for(const key of ['current_seconds','total_seconds'])assert.equal(s[key],p.stats[key]);
  for(const key of ['cigarettes','free_minutes','life_minutes'])assert(s[key].eq(p.stats[key]),key);
  assert.deepEqual(Object.keys(s.money).sort(),Object.keys(p.stats.money).sort());
  for(const [currency,value] of Object.entries(s.money))assert(value.eq(p.stats.money[currency]),currency);
});

const period=(seconds,extra={})=>({...profile,start:stamp(now-seconds*1000),...extra});
const morning=(streaks,instant=now)=>morningReport(calculate(streaks,instant),'2026-11-16',42);

test('compact morning example has correct local goal, whole estimates and a fact',()=>{
  const seconds=8*86400+4*3600,text=morning([period(seconds)]);
  assert.equal(text,'🚭 <b>8 дней 4 часа без сигарет</b>\n\n🎯 До 14 дней — 5 дней 20 часов\n▓▓░░░░░░░░ 17%\n\n🚬 Не выкурено: 163 шт.\n💰 Сэкономлено: 2 042 ₽\n⏳ Свободного времени: 13 ч. 36 мин.\n\n✨ <b>Факт дня</b>\n\n'+dailyFact(seconds,'2026-11-16',42));
  assert(text.length<400);
});

test('facts are deterministic, age-appropriate and rotate across dates and age boundaries',()=>{
  const seen=new Set();
  for(let i=0;i<100;i++) {
    const date=day=>new Date(Date.UTC(2026,0,day+1)).toISOString().slice(0,10);
    const fact=dailyFact(i*86400,date(i),42);
    assert.equal(fact,dailyFact(i*86400,date(i),42));
    assert.notEqual(fact,dailyFact((i+1)*86400,date(i+1),42));
    seen.add(fact);
  }
  assert(seen.size>=18);
});

test('duration omits zero parts and minutes from a day, with Russian plural forms',()=>{
  for(const [seconds,expected] of [[0,'меньше минуты'],[59,'меньше минуты'],[60,'1 мин.'],[3600,'1 ч.'],[3660,'1 ч. 1 мин.'],[86460,'1 дн.'],[90060,'1 дн. 1 ч.']])assert.equal(compactDuration(seconds),expected);
  for(const [days,expected] of [[1,'1 день'],[2,'2 дня'],[5,'5 дней'],[11,'11 дней'],[21,'21 день'],[22,'22 дня']])assert.equal(compactDuration(days*86400,true),expected);
});

test('target boundaries and multi-year progress always have ten cells and never overflow',()=>{
  for(const days of [...milestones,730,1095])for(const delta of [-1,0,1]) {
    const seconds=days*86400+delta,text=morning([period(seconds)]);
    const [,cells,percent]=text.match(/([▓░]+) (\d+)%/);
    const target=Number(text.match(/До (\d+)/)[1]);
    assert.equal(cells.length,10);assert(Number(percent)>=0&&Number(percent)<100);
    assert(target*86400>seconds);
    const from=[0,...milestones,730,1095].filter(d=>d*86400<=seconds).at(-1);
    assert.equal(Number(percent),Math.min(99,Math.round((seconds-from*86400)/((target-from)*86400)*100)));
  }
});

test('all calculations use the supplied instant and preserve Decimal precision',()=>{
  const p=period(86399,{daily:17,price:'250.35',minutes:'5.3'}),before=JSON.stringify(p);
  const a=calculate([p],now),b=calculate([p],now+1000);
  assert.equal(a.current_seconds,86399);assert.equal(b.current_seconds,86400);
  assert.equal(b.cigarettes.toString(),'17');assert.equal(b.money.RUB.toString(),'212.7975');
  assert.equal(b.free_minutes.toString(),'90.1');assert.equal(b.life_minutes.toString(),'340');
  assert.match(morning([p],now),/До 1 дня/);
  assert.match(morning([p],now+1000),/До 3 дней/);
  assert.equal(JSON.stringify(p),before);
});

test('lapse resets series and health, keeps historical totals and currencies without conversion',()=>{
  const history=period(5*86400,{end:stamp(now-3*86400000)}),active=period(3600,{currency:'EUR',price:'6.1'});
  const s=calculate([history,active],now),text=morning([history,active]);
  assert.equal(s.current_seconds,3600);assert.equal(s.total_seconds,2*86400+3600);
  assert.match(text,/1 час без сигарет/);assert.match(text,/До 1 дня/);
  assert.match(text,/41 шт\./);assert.match(text,/500 ₽ \+ 0 €/);
  assert(!healthReport(s.current_seconds,true).includes('48 часов'));
  assert.match(morning([period(0,{currency:'KZT'})],now),/0 KZT/);
  assert(!morning([period(86400,{currency:'USD'})],now).includes('₽'));
});

test('health limits the summary to two reached and three upcoming stages, with sources',()=>{
  for(const sec of [0,1200,259200,315360001]) {
    const text=healthReport(sec),all=healthReport(sec,true);
    const reached=stages.filter(([at])=>at<=sec),next=stages.filter(([at])=>at>sec).slice(0,3);
    for(const [,label,fact,url] of reached)assert(all.includes(`${label} — ${fact} <a href="${url}">Источник</a>`));
    for(const [,,fact,url] of next)assert(text.includes(fact)&&text.includes(url));
    assert.equal(text.match(/^✅ /gm)?.length??0,Math.min(2,reached.length));
    assert.equal(text.match(/^✨ /gm)?.length??0,next.length);
    assert.match(text,/Сроки индивидуальны/);assert(all.length<4096);
  }
  const method=methodologyReport(true);assert(method.length<4096);
  for(const source of [A.ADDICTION,A.MODEL_NOTE])assert(method.includes(source));
  assert.match(method,/86 400/);assert.match(method,/Промежутки срыва исключены/);
  assert(!methodologyReport().includes('86 400'));
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
    assert(calls[1].body.text.includes(button.callback_data==='report:health'?'Следующие изменения':'по статистической модели'));
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
  assert.equal(calls[0].body.text,morningReport(calculate(await db.streaks(1),now),'2026-11-16',1));
  assert.equal((await db.one('SELECT * FROM reports WHERE user_id=1 AND local_date=?','2026-11-16')).status,'sent');
  await handleUpdate({message:{chat:{id:1,type:'private'},from:{id:1},text:A.MENU_LABELS[0]}},db,env,now,api);
  assert.match(calls.at(-1).body.text,/Статистический эквивалент жизни/);
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data,'awards');
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
test('all eight screens, emitted button links and account setup work end to end',async()=>{
  const {db,env}=database();
  let seq=0,last;
  const api=async(_,method,body)=>{if(method==='sendMessage')last=body;};
  const send=text=>handleUpdate(message(42,++seq,text),db,env,now,api);
  const cb=data=>handleUpdate(callback(42,++seq,data),db,env,now,api);
  const click=async label=>{
    const button=last.reply_markup.inline_keyboard.flat().find(b=>b.text===label);
    assert(button,label);
    await cb(button.callback_data);
  };
  const press=async label=>{
    assert(last.reply_markup.keyboard.flat().some(b=>b.text===label),label);
    await send(label);
  };
  await send('/start');
  await press('📅 Указать дату и время');
  await send('01.01.1899 10:00');assert.match(last.text,/1900/);
  await send('01.01.2026 10:00');
  await press('Другое');await send('18');
  await send('250');
  assert.equal(await db.user(42),null);
  await press('Europe/Moscow');
  assert.match(last.text,/Всё готово/);
  const user=await db.user(42);
  assert.deepEqual([user.daily,user.price,user.currency,user.timezone,user.pack,user.minutes,user.report_time],[18,'250','RUB','Europe/Moscow',20,'5','08:00']);
  assert.equal(await db.state(42,123456).then(s=>s.state),undefined);
  await press(A.MENU_LABELS[0]);assert.match(last.text,/Мой прогресс/);
  await click('🏆 Все достижения');assert.match(last.text,/Получено: 8 из 9/);
  await click('📊 Мой прогресс');
  await send('/morning');assert.match(last.text,/Факт дня/);
  await click('ℹ️ Как считаем');assert(!last.text.includes('86 400'));
  await click('📖 Подробнее и источники');assert.match(last.text,/86 400/);
  await send('/morning');await click('🫁 Здоровье');assert.match(last.text,/Восстановление организма/);
  await click('✅ Все достигнутые изменения');assert.match(last.text,/Все достигнутые изменения/);
  await click('🫁 Здоровье');
  await send(A.MENU_LABELS[3]);assert.match(last.text,/Дай себе 5 минут/);
  await click('✅ Отпустило');assert.match(last.text,/Серия продолжается/);
  await send(A.MENU_LABELS[3]);await click('🚬 Был срыв');
  await click('Указать другое время или количество');
  await send('15.11.2026 19:00');await press('3');await send('15.11.2026 18:00');
  assert.match(last.text,/не раньше первой/);
  await send('15.11.2026 20:00');
  const {nonce}=await db.state(42,123456);
  const before=await db.streaks(42);
  assert.equal(before.length,1);
  await click('Подтвердить срыв');await cb('lapse:confirm:'+nonce);
  const [closed,active]=await db.streaks(42);
  assert.equal(closed.lapse_count,3);
  assert.equal(closed.end,stamp(Date.parse('2026-11-15T16:00Z')));
  assert.equal(active.start,stamp(Date.parse('2026-11-15T17:00Z')));
  assert.equal(calculate(before,now).total_seconds-calculate([closed,active],now).total_seconds,3600);
  await send(A.MENU_LABELS[2]);assert.match(last.text,/Получено: 8 из 9/);
  assert.match(last.text,/💎 Три месяца/);
  await send(A.MENU_LABELS[4]);assert.match(last.text,/⚙️ Настройки/);
  await click('⏰ Уведомления');await click('🔕 Отключить рассылку');
  assert.equal((await db.user(42)).next_due_at,null);
  await click('🔔 Включить рассылку');assert((await db.user(42)).next_due_at>now);
  await click('🕒 Изменить время');await send('06:00');
  await send(A.MENU_LABELS[4]);await click('💰 Стоимость');await send('6 EUR');
  await send(A.MENU_LABELS[4]);await click('📦 Размер пачки');await send('25');
  await send(A.MENU_LABELS[4]);await click('🚭 Дата отказа');await send('15.11.2026 20:30');
  await send(A.MENU_LABELS[4]);await click('🚬 Привычка');await press('20');
  await send(A.MENU_LABELS[4]);await click('⏳ Минут на сигарету');await press('7');
  await send(A.MENU_LABELS[4]);await click('🌍 Часовой пояс');await send('Europe/Berlin');
  const edited=await db.user(42);
  assert.deepEqual([edited.price,edited.currency,edited.pack,edited.daily,edited.minutes,edited.timezone,edited.report_time],['6','EUR',25,20,'7','Europe/Berlin','06:00']);
  await send('/start');assert.deepEqual(await db.user(42),edited);
  await send(A.MENU_LABELS[4]);await click('🗑 Удалить мои данные');await click('Отмена');
  assert.deepEqual(await db.user(42),edited);
  await send(A.MENU_LABELS[4]);await click('🚬 Отметить срыв');await click('Отмена');
  assert.equal((await db.streaks(42)).length,2);
});

test('registration corrects an ambiguous civil time and supports the now shortcut',async()=>{
  const {db,env}=database();
  const send=(id,text)=>handleUpdate(message(id,1,text),db,env,now,async()=>{});
  for(const [id,start] of [[42,'25.10.2026 02:30'],[43,'🚭 Сейчас']]) {
    for(const value of ['/start',start,'20','5,50 EUR','Europe/Berlin'])await send(id,value);
  }
  assert.equal(await db.user(42),null);
  assert.equal((await db.state(42,123456)).date_final,true);
  await send(42,'25.10.2026 02:30 +0200');
  assert.equal(Date.parse((await db.streaks(42))[0].start),Date.parse('2026-10-25T00:30Z'));
  assert.equal((await db.user(42)).price,'5.50');
  assert.equal(Date.parse((await db.streaks(43))[0].start),Math.floor(now/60000)*60000);
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
