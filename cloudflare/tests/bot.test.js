import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {database,now,profile,message,callback} from './helpers.js';
import {A,parseDate,local,stamp,calculate,compactDuration,morningReport,reportButtons,progressReport,detailedProgressReport,healthReport,methodologyReport,milestones,menu,RECOVERY_LABEL} from '../src/core.js';
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
const morning=(streaks,instant=now,milestone=null)=>morningReport(calculate(streaks,instant),instant,'Europe/Moscow',42,streaks.at(-1)?.start,milestone);

test('compact morning example has correct local goal, whole estimates and a fact',()=>{
  const seconds=8*86400+4*3600,text=morning([period(seconds)]);
  assert(text.startsWith('☀️ <b>Доброе утро!</b>\n\n<b>8 дней 4 часа без сигарет</b>\n\n🎯 Следующий рубеж — <b>14 дней</b>\nУчасток: 7 дней → 14 дней\n▰▰▱▱▱▱▱▱▱▱ <b>17%</b>\nДо рубежа — <b>5 дней 20 часов</b>\n\n🚬 Не выкурено: <b>≈163 шт.</b>\n💰 Сэкономлено: <b>≈2 042 ₽</b>\n⏳ Свободное время: <b>≈13 часов 36 минут</b>\n\n🫁 <b>Факт о здоровье</b>\n'+dailyFact(seconds,'2026-11-16',42)+'\n\n💡 <b>Мысль дня</b>\n'));
  assert(A.THOUGHTS.includes(text.split('\n').at(-1)));assert(text.length<700);
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
    const [,cells,percent]=text.match(/([▰▱]+) <b>(\d+)%<\/b>/);
    const target=Number(text.match(/Следующий рубеж — <b>(\d+)/)[1]);
    assert.equal(cells.length,10);assert(Number(percent)>=0&&Number(percent)<100);
    assert(target*86400>seconds);
    const from=[0,...milestones,730,1095].filter(d=>d*86400<=seconds).at(-1);
    assert.equal(Number(percent),Math.min(99,Math.round((seconds-from*86400)/((target-from)*86400)*100)));
    assert(text.includes(`Участок: ${from?compactDuration(from*86400,true):'старт'} → ${compactDuration(target*86400,true)}`));
    if(delta===-1)assert.match(text,/До рубежа — <b>меньше часа<\/b>/);
  }
});

test('23-day progress stays compact; detailed statistics keep lifetime estimates and historical currencies',()=>{
  const current=period(23*86400),past=period(27*86400,{end:stamp(now-25*86400000),currency:'EUR',price:'6'});
  const earned=new Set([1,3,7,14]);
  const headline=progressReport(calculate([current],now),earned);
  assert.match(headline,/🚭 <b>Мой прогресс<\/b>\n\n<b>23 дня без сигарет<\/b>/);
  assert.match(headline,/Участок: 14 дней → 30 дней\n▰▰▰▰▰▰▱▱▱▱ <b>56%<\/b>\nДо рубежа — <b>7 дней<\/b>/);
  for(const value of ['≈460 шт.','≈5 750 ₽','≈1 день 14 часов','<b>4 из 9</b>'])assert(headline.includes(value),value);
  assert.doesNotMatch(headline,/Статистический эквивалент жизни|Мои достижения/);
  const details=detailedProgressReport(calculate([past,current],now),earned);
  assert.match(details,/Всего без сигарет: <b>25 дней<\/b>/);
  assert.match(details,/≈12 € \+ ≈5 750 ₽/);
  assert.match(details,/Статистический эквивалент жизни: <b>≈[^<]+<\/b>\nЭто оценка по статистической модели/);
  assert.match(details,/Достижения: <b>4 из 9<\/b>\n🌱 Первый день/);
  const short=progressReport(calculate([period(6*3600)],now),new Set());
  assert.match(short,/<b>6 часов без сигарет<\/b>/);
  assert.match(short,/Участок: старт → 1 день\n[▰▱]{10} <b>25%<\/b>\nДо рубежа — <b>18 часов<\/b>/);
});

test('milestone report keeps the next interval and never congratulates an unreached milestone',()=>{
  const streak=period(30*86400),stats=calculate([streak],now);
  const text=morning([streak],now,30);
  assert.match(text,/Месяц без сигарет!/);
  assert.match(text,/<b>30 дней без сигарет<\/b>/);
  assert.match(text,/Участок: 30 дней → 60 дней\n▱{10} <b>0%<\/b>\nДо рубежа — <b>30 дней/);
  for(const block of ['Не выкурено','Факт о здоровье','Мысль дня'])assert(text.includes(block));
  assert.equal(morningReport(stats,now,'Europe/Moscow',42,streak.start),text);
  assert.doesNotMatch(morning([period(30*86400-1)],now,30),/Месяц без сигарет!/);
  assert.doesNotMatch(morningReport(calculate([streak],now+86400000),now+86400000,'Europe/Moscow',42,streak.start),/Месяц без сигарет!/);
});

test('repeated morning reports keep the fact and thought through an age boundary in the same local day',async()=>{
  const {db,env}=database();
  const crossing=Date.parse('2026-11-16T13:45Z');
  await db.register(41,41,{...profile,start:stamp(crossing-7*86400000),timezone:'Asia/Tokyo'},now);
  const content=async instant=>{
    let text;
    await handleUpdate(message(41,1,'/morning',instant),db,env,instant,async(_,method,body)=>{if(method==='sendMessage')text=body.text;});
    return {text,blocks:text.split('🫁 <b>Факт о здоровье</b>\n')[1]};
  };
  const before=await content(crossing-60000),after=await content(crossing+60000),tomorrow=await content(crossing+7200000);
  assert.match(after.text,/Первая неделя|Целая неделя без сигарет!/);
  assert.equal(before.blocks,after.blocks);assert.notEqual(after.blocks,tomorrow.blocks);
});

test('all calculations use the supplied instant and preserve Decimal precision',()=>{
  const p=period(86399,{daily:17,price:'250.35',minutes:'5.3'}),before=JSON.stringify(p);
  const a=calculate([p],now),b=calculate([p],now+1000);
  assert.equal(a.current_seconds,86399);assert.equal(b.current_seconds,86400);
  assert.equal(b.cigarettes.toString(),'17');assert.equal(b.money.RUB.toString(),'212.7975');
  assert.equal(b.free_minutes.toString(),'90.1');assert.equal(b.life_minutes.toString(),'340');
  assert.match(morning([p],now),/Следующий рубеж — <b>1 день/);
  assert.match(morning([p],now+1000),/Следующий рубеж — <b>3 дня/);
  assert.equal(JSON.stringify(p),before);
});

test('lapse resets series and health, keeps historical totals and currencies without conversion',()=>{
  const history=period(5*86400,{end:stamp(now-3*86400000)}),active=period(3600,{currency:'EUR',price:'6.1'});
  const s=calculate([history,active],now),text=morning([history,active]);
  assert.equal(s.current_seconds,3600);assert.equal(s.total_seconds,2*86400+3600);
  assert.match(text,/1 час без сигарет/);assert.match(text,/Следующий рубеж — <b>1 день/);
  assert.match(text,/≈41 шт\./);assert.match(text,/≈500 ₽ \+ ≈0 €/);
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
    const expected={'report:health':'Следующие изменения','progress':'Мой прогресс','report:methodology':'по статистической модели'};
    assert(calls[1].body.text.includes(expected[button.callback_data]));
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
  const streaks=await db.streaks(1);
  assert.equal(calls[0].body.text,morningReport(calculate(streaks,now),now,'Asia/Tokyo',1,streaks[0].start,null));
  assert.equal((await db.one('SELECT * FROM reports WHERE user_id=1 AND local_date=?','2026-11-16')).status,'sent');
  await handleUpdate({message:{chat:{id:1,type:'private'},from:{id:1},text:A.MENU_LABELS[0]}},db,env,now,api);
  assert.doesNotMatch(calls.at(-1).body.text,/Статистический эквивалент жизни/);
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data,'progress:details');
  await handleUpdate(callback(1,2,'progress:details'),db,env,now,api);
  assert.match(calls.at(-1).body.text,/Статистический эквивалент жизни/);
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
  let seq=0,last,keyboard;
  const api=async(_,method,body)=>{if(method==='sendMessage'){last=body;if(body.reply_markup?.keyboard)keyboard=body.reply_markup.keyboard;}};
  const send=text=>handleUpdate(message(42,++seq,text),db,env,now,api);
  const cb=data=>handleUpdate(callback(42,++seq,data),db,env,now,api);
  const click=async label=>{
    const button=last.reply_markup.inline_keyboard.flat().find(b=>b.text===label);
    assert(button,label);
    await cb(button.callback_data);
  };
  const press=async label=>{
    assert(keyboard.flat().some(b=>b.text===label),label);
    await send(label);
  };
  await send('/start');
  assert.match(last.text,/Бесплатно\. Без рекламы\. Без осуждения\./);
  await click('🔐 О моих данных');assert.match(last.text,/Сохраняем Telegram ID/);
  await send('/start');await click('🚭 Начать');
  await click('Указать дату и время');
  await send('01.01.1899 10:00');assert.match(last.text,/1900/);
  await send('01.01.2026 10:00');
  await click('Другое');await send('18');
  await send('250');
  assert.equal(await db.user(42),null);
  await click('Москва (UTC+3)');
  assert.match(last.text,/Ежедневный отчёт/);
  const user=await db.user(42);
  assert.deepEqual([user.daily,user.price,user.currency,user.timezone,user.pack,user.minutes,user.report_time],[18,'250','RUB','Europe/Moscow',20,'5','08:00']);
  assert.equal(user.enabled,0);assert.equal(user.next_due_at,null);
  await click('Не сейчас');
  assert.equal(await db.state(42,123456).then(s=>s.state),undefined);
  await press(A.MENU_LABELS[0]);assert.match(last.text,/Мой прогресс/);
  await click('📊 Подробная статистика');assert.match(last.text,/Достижения: <b>8 из 9/);
  await click('📊 Мой прогресс');
  await send('/morning');assert.match(last.text,/Факт о здоровье/);
  await click('ℹ️ Как считаем');assert(!last.text.includes('86 400'));
  await click('📖 Подробнее и источники');assert.match(last.text,/86 400/);
  await send('/morning');await click(RECOVERY_LABEL);assert.match(last.text,/Восстановление организма/);
  await click('✅ Все достигнутые изменения');assert.match(last.text,/Все достигнутые изменения/);
  await click(RECOVERY_LABEL);
  await send(A.MENU_LABELS[3]);assert.match(last.text,/Дай себе 5 минут/);
  await click('✅ Отпустило');assert.match(last.text,/Серия продолжается/);
  await send(A.MENU_LABELS[3]);await click('🚬 Был срыв');
  await click('Указать другое время или количество');
  await send('15.11.2026 19:00');await click('3');await send('15.11.2026 18:00');
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
  await send(A.MENU_LABELS[2]);assert.match(last.text,/8 из 9 наград/);
  assert.match(last.text,/💎 90 дней — Три месяца/);
  await send(A.MENU_LABELS[4]);assert.match(last.text,/⚙️ Настройки/);
  await click('⏰ Уведомления');await click('🔔 Подключить отчёты');await click('07:00');
  await send(A.MENU_LABELS[4]);await click('⏰ Уведомления');await click('🔕 Отключить рассылку');
  assert.equal((await db.user(42)).next_due_at,null);
  await click('🔔 Подключить отчёты');await click('08:00');assert((await db.user(42)).next_due_at>now);
  await send(A.MENU_LABELS[4]);await click('⏰ Уведомления');await click('🕒 Изменить время');await send('06:00');
  await send(A.MENU_LABELS[4]);await click('💰 Стоимость');await send('6 EUR');
  await send(A.MENU_LABELS[4]);await click('📦 Размер пачки');await send('25');
  await send(A.MENU_LABELS[4]);await click('🚭 Дата отказа');await send('15.11.2026 20:30');
  await send(A.MENU_LABELS[4]);await click('🚬 Привычка');await click('20');
  await send(A.MENU_LABELS[4]);await click('⏳ Минут на сигарету');await click('7');
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
    await send(id,'/start');
    const {nonce}=await db.state(id,123456);
    await handleUpdate(callback(id,2,`f:${nonce}:begin`),db,env,now,async()=>{});
    for(const value of [start,'20','5,50 EUR','Europe/Berlin'])await send(id,value);
  }
  assert.equal(await db.user(42),null);
  assert.equal((await db.state(42,123456)).date_final,true);
  await send(42,'25.10.2026 02:30 +0200');
  assert.equal(Date.parse((await db.streaks(42))[0].start),Date.parse('2026-10-25T00:30Z'));
  assert.equal((await db.user(42)).price,'5.50');
  assert.equal(Date.parse((await db.streaks(43))[0].start),Math.floor(now/60000)*60000);
});

function conversation(db,env,id,time=now) {
  const replies=[];
  let seq=0;
  const api=async(_,method,body)=>{if(method==='sendMessage')replies.push(body);};
  const send=text=>handleUpdate(message(id,++seq,text,time),db,env,time,api);
  const cb=action=>handleUpdate(callback(id,++seq,action,time),db,env,time,api);
  const last=()=>replies.at(-1);
  const button=label=>{
    const found=last().reply_markup?.inline_keyboard?.flat().find(b=>b.text===label);
    assert(found,label);assert(Buffer.byteLength(found.callback_data)<=64);
    return found.callback_data;
  };
  return {send,cb,click:label=>cb(button(label)),button,last,replies};
}

test('new and legacy menu and report buttons route to real screens',async()=>{
  const {db,env}=database();await db.register(590,590,profile,now);
  const chat=conversation(db,env,590);
  await chat.send('/start');
  assert.deepEqual(chat.replies[0].reply_markup,menu());
  assert.deepEqual(menu().keyboard.map(row=>row.map(button=>button.text)),[
    ['📊 Мой прогресс','🆘 Хочу закурить'],['🫁 Восстановление'],['🏆 Достижения','⚙️ Настройки']
  ]);
  assert.equal(menu().is_persistent,true);
  await chat.click('📊 Подробная статистика');assert.match(chat.last().text,/Подробная статистика/);
  await chat.click('ℹ️ Как считаем');await chat.click('📖 Подробнее и источники');assert(chat.last().text.includes(A.ADDICTION));
  await chat.click('📊 Мой прогресс');await chat.click('📝 Отметить срыв');
  assert.equal((await db.state(590,123456)).state,'Form:lapse');await chat.click('Отмена');
  for(const label of [RECOVERY_LABEL,A.MENU_LABELS[1]]) {
    await chat.send(label);assert.match(chat.last().text,/Восстановление организма/);
    assert.match(chat.last().text,/<a href="https:\/\//);
  }
  await chat.cb('report:health');assert.match(chat.last().text,/Восстановление организма/);
  await chat.cb('awards');assert.match(chat.last().text,/Твои достижения/);
  await chat.send('/morning');await chat.click('📊 Мой прогресс');assert.match(chat.last().text,/Мой прогресс/);
});

test('onboarding resumes existing drafts; every step can go back and cancel',async()=>{
  const {db,env}=database();
  const fields=['start','daily','cost','timezone'];
  const values=['Сейчас','18','250'];
  for(let i=0;i<fields.length;i++) {
    const id=600+i,chat=conversation(db,env,id);
    await chat.send('/start');await chat.click('🚭 Начать');
    for(const value of values.slice(0,i))await chat.send(value);
    assert.match(chat.last().text,new RegExp(`Шаг ${i+1} из 4`));
    const oldCancel=chat.button('Отмена');
    await chat.send('/start');
    assert.equal((await db.state(id,123456)).field,fields[i]);
    await chat.cb(oldCancel);assert.match(chat.last().text,/устарела/);
    assert.equal((await db.state(id,123456)).field,fields[i]);
    await chat.send('/start');await chat.click('Назад');
    if(i) {
      assert.equal((await db.state(id,123456)).field,fields[i-1]);
      await chat.send(values[i-1]);await chat.click('Отмена');
    } else {
      assert.equal((await db.state(id,123456)).state,'Form:welcome');
      await chat.click('🚭 Начать');await chat.click('Отмена');
    }
    assert.equal((await db.state(id,123456)).state,'Form:welcome');
    assert.equal(await db.user(id),null);
  }
  await db.saveState(610,123456,{state:'Form:value',mode:'register',field:'cost',draft:{...profile,enabled:undefined}});
  const legacy=conversation(db,env,610);
  await legacy.send('/start');assert.match(legacy.last().text,/Шаг 3 из 4/);
  await legacy.send('7 EUR');await legacy.click('Другой город');
  await legacy.send('НетТакогоГорода');assert.match(legacy.last().text,/Неизвестный пояс/);legacy.button('Назад');legacy.button('Отмена');
  await legacy.send('Berlin');
  assert.equal((await db.user(610)).timezone,'Europe/Berlin');assert.equal((await db.user(610)).daily,20);
  assert.equal((await db.user(610)).enabled,0);
});

test('relative date uses the chosen civil day and manual forms keep navigation',async()=>{
  const {db,env}=database();
  const time=Date.parse('2026-11-16T20:05Z');
  const chat=conversation(db,env,620,time);
  await chat.send('/start');await chat.click('🚭 Начать');await chat.click('Вчера');
  await chat.send('25:00');assert.match(chat.last().text,/от 0:00 до 23:59/);chat.button('Назад');chat.button('Отмена');
  await chat.send('6:00');await chat.click('Другое');
  await chat.send('0');assert.match(chat.last().text,/от 1 до 200/);chat.button('Назад');chat.button('Отмена');
  await chat.send('20');await chat.send('250');await chat.click('Владивосток (UTC+10)');
  assert.equal(Date.parse((await db.streaks(620))[0].start),Date.parse('2026-11-15T20:00Z'));
  assert(chat.replies.some(reply=>reply.reply_markup?.keyboard));
  assert.match(chat.replies.at(-2).text,/Мой прогресс/);
  await chat.click('Не сейчас');assert.equal((await db.user(620)).next_due_at,null);
});

test('each report preset saves immediately; manual and existing subscriptions keep correct scheduling',async()=>{
  const {db,env}=database();await db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
  for(const [index,clock] of ['06:00','07:00','08:00','09:00','10:00','12:00'].entries()) {
    const id=630+index,chat=conversation(db,env,id);
    await db.register(id,id,{...profile,enabled:0},now);
    await chat.cb('notifications');await chat.click('🔔 Подключить отчёты');await chat.click(clock);
    assert.equal((await db.user(id)).report_time,clock);
    assert.equal((await db.user(id)).enabled,1);assert((await db.user(id)).next_due_at>now);
    assert.equal((await db.state(id,123456)).state,undefined);
    assert.match(chat.last().text,/Ежедневный отчёт подключён/);
  }
  const id=650,chat=conversation(db,env,id);
  await db.register(id,id,{...profile,enabled:0},now);
  await chat.cb('notifications');await chat.click('🕒 Изменить время');await chat.click('🕒 Указать своё время');
  await chat.send('24:00');assert.match(chat.last().text,/от 0:00 до 23:59/);chat.button('Назад');chat.button('Отмена');
  await chat.send('6:00');
  let user=await db.user(id);assert.deepEqual([user.enabled,user.report_time,user.next_due_at],[0,'06:00',null]);
  await chat.cb('notifications');await chat.click('🔔 Подключить отчёты');await chat.click('🕒 Указать своё время');
  await chat.send('6:00');assert.equal((await db.user(id)).enabled,1);
  await db.run("UPDATE reports SET status='sent' WHERE user_id=?",id);
  await chat.cb('notifications');await chat.click('🕒 Изменить время');await chat.click('🕒 Указать своё время');await chat.send('18:30');
  user=await db.user(id);
  assert.deepEqual([user.enabled,user.report_time,user.timezone,user.next_due_at],[1,'18:30','Europe/Moscow',Date.parse('2026-11-17T15:30:00Z')]);
  assert.match(chat.last().text,/Следующий отчёт: 17\.11\.2026, 18:30/);
  const today=[];await tick(env,Date.parse('2026-11-16T15:31Z'),async(_,__,body)=>today.push(body.chat_id));assert(!today.includes(id));
  const before={user,streaks:await db.streaks(id),awards:await db.awards(id,now)};
  await chat.send('/start');
  assert.deepEqual({user:await db.user(id),streaks:await db.streaks(id),awards:await db.awards(id,now)},before);
  await db.run("UPDATE cloud_control SET value='0' WHERE key='active'");
  await chat.cb('notifications');assert.doesNotMatch(chat.last().text,/Следующий отчёт:/);
});

test('permanent menu exits a manual form with one response and invalidates its buttons',async()=>{
  const {db,env}=database();await db.register(660,660,profile,now);
  const chat=conversation(db,env,660);
  await chat.cb('edit:start');await chat.click('Указать дату и время');
  const stale=chat.button('Отмена'),before=chat.replies.length;
  await chat.send(A.MENU_LABELS[0]);
  assert.equal(chat.replies.length,before+1);assert.match(chat.last().text,/Мой прогресс/);
  await chat.cb('edit:daily');const state=await db.state(660,123456);
  await chat.cb(stale);assert.match(chat.last().text,/устарела/);
  assert.deepEqual(await db.state(660,123456),state);
  await chat.cb('edit:daily');await chat.click('Главное меню');
  assert.match(chat.last().text,/Мой прогресс/);assert.equal((await db.state(660,123456)).state,undefined);
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
