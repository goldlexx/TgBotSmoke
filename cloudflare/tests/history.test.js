import {test} from 'node:test';
import assert from 'node:assert/strict';
import {handleUpdate} from '../src/bot.js';
import {awardsReport,calculate,milestones,stamp} from '../src/core.js';
import {historySnapshot,historyTarget} from '../src/history.js';
import {tick,webhook} from '../src/worker.js';
import {database,now,profile,message,callback,request} from './helpers.js';

const day=86400000;
const at=days=>stamp(now+days*day);
const zone='Europe/Moscow';
const active=db=>db.run("UPDATE cloud_control SET value='1' WHERE key='active'");
async function addLapse(db,id,begin,last,count=null) {
  const rows=await db.streaks(id);
  await db.lapse(id,rows.at(-1).id,at(begin),at(last),now,count);
  return rows.at(-1).id;
}
async function changeFor(db,id,kind,key,patch={}) {
  const target=historyTarget(await db.streaks(id),kind,key);
  return {kind,key,snapshot:historySnapshot(target),begin:target.first.end,last:target.second?.start,count:target.first.lapse_count,...patch};
}
function dialog(db,env,id) {
  let seq=0,last;
  const send=update=>handleUpdate(update,db,env,now,async(_,method,body)=>{if(method==='sendMessage')last=body;});
  const cb=action=>send(callback(id,++seq,action));
  const button=label=>{
    const key=last.reply_markup.inline_keyboard.flat().find(b=>b.text===label)?.callback_data;
    assert(key,label);assert(Buffer.byteLength(key)<=64,label);return key;
  };
  return {cb,button,press:label=>cb(button(label)),text:text=>send(message(id,++seq,text)),result:()=>last.text};
}

test('history opens from progress, separates first and current series, and pages both lists',async()=>{
  const {db,env}=database();const id=810;
  await db.register(id,id,{...profile,start:stamp(Math.floor(now/60000)*60000-22*day)},now);
  const chat=dialog(db,env,id);
  await chat.text('/start');await chat.press('📅 История');
  assert.match(chat.result(),/Текущая серия:<\/b> 22 дня/);
  assert.match(chat.result(),/Начало отслеживания:<\/b> 25\.10\.2026, 12:00/);
  assert.match(chat.result(),/Срывов не зарегистрировано/);
  await chat.press('Серии без сигарет');assert.match(chat.result(),/Текущая серия<\/b>\n<b>22 дня/);assert.doesNotMatch(chat.result(),/Завершённая серия/);
  for(let offset=-18;offset<=-3;offset+=3)await addLapse(db,id,offset,offset+1,offset===-18?null:3);
  await chat.press('Назад');assert.match(chat.result(),/Текущая серия:<\/b> 2 дня/);assert.match(chat.result(),/срывов: <b>6/);
  await chat.press('Срывы');assert.match(chat.result(),/Срыв №6/);assert.match(chat.result(),/Страница 1 из 2/);
  await chat.press('→');assert.match(chat.result(),/Срыв №1/);assert.match(chat.result(),/Количество сигарет: не указано/);
  await chat.press('Открыть срыв №1');assert.match(chat.result(),/Первая сигарета: 29\.10\.2026/);
  await chat.press('Назад');assert.match(chat.result(),/Страница 2 из 2/);await chat.press('Назад');
  await chat.press('Серии без сигарет');assert.match(chat.result(),/Завершённая серия<\/b>\n<b>2 дня/);
  await chat.press('→');assert.match(chat.result(),/Завершённая серия<\/b>\n<b>4 дня/);
});

test('episode edit previews old and proposed values, cancels, confirms once and preserves the other episode',async()=>{
  const {db,env}=database();const id=811;
  await db.register(id,id,{...profile,start:at(-10)},now);
  const key=await addLapse(db,id,-8,-7,2);
  await db.change(id,'cost',{price:'6',currency:'EUR'},now);
  await addLapse(db,id,-5,-4,1);
  const before=await db.streaks(id),settings=await db.user(id);
  const chat=dialog(db,env,id);
  await chat.cb('history:episode:'+key);await chat.press('Исправить');
  await chat.press('Последняя сигарета');await chat.text('08.11.2026 18:00');
  await chat.press('Количество сигарет');await chat.text('4');await chat.press('Проверить изменения');
  assert.match(chat.result(),/<b>Было<\/b>[\s\S]+Количество сигарет: 2[\s\S]+<b>Будет<\/b>[\s\S]+Количество сигарет: 4/);
  const stale=chat.button('Сохранить изменения');await chat.press('Отмена');assert.match(chat.result(),/Срыв №1/);
  await chat.cb(stale);assert.match(chat.result(),/устарела/);assert.deepEqual(await db.streaks(id),before);
  await chat.cb('history:episode:'+key);await chat.press('Исправить');
  await chat.press('Первая сигарета');await chat.text('08.11.2026 10:00');
  await chat.press('Последняя сигарета');await chat.text('08.11.2026 18:00');
  await chat.press('Количество сигарет');await chat.text('4');await chat.press('Проверить изменения');
  const confirm=chat.button('Сохранить изменения');await chat.cb(confirm);assert.match(chat.result(),/Изменения сохранены/);
  await chat.cb(confirm);assert.match(chat.result(),/устарела/);
  const after=await db.streaks(id);
  assert.deepEqual({...after[0]},{...before[0],end:stamp(Date.parse('2026-11-08T07:00Z')),lapse_count:4});
  assert.deepEqual({...after[1],start:before[1].start},{...before[1]});
  assert.deepEqual(after[2],before[2]);assert.deepEqual(await db.user(id),settings);
  const stats=calculate(after,now);assert.deepEqual(Object.keys(stats.money),['RUB','EUR']);
  assert.equal(stats.current_seconds,Math.floor((now-Date.parse(before[2].start))/1000));
  assert.equal(stats.total_seconds,Math.floor((Date.parse(after[0].end)-Date.parse(after[0].start)+Date.parse(after[1].end)-Date.parse(after[1].start)+now-Date.parse(after[2].start))/1000));
  assert(stats.life_minutes.eq(stats.cigarettes.mul(20)));assert(stats.free_minutes.gt(0));
});

test('only equal snapshots merge; invalid overlaps, future dates, stale snapshots and foreign IDs fail closed',async()=>{
  const {db,env}=database();const id=812;
  await db.register(id,id,{...profile,start:at(-12)},now);
  await db.register(813,813,{...profile,start:at(-12)},now);
  const key=await addLapse(db,id,-10,-9,2);
  const later=await addLapse(db,id,-6,-5,3);
  const before=await db.streaks(id);
  const edit=await changeFor(db,id,'edit',key);
  for(const patch of [{begin:at(-13)},{last:at(-11)},{last:at(-5)},{last:at(1)},{count:0}]) {
    await assert.rejects(db.changeHistory(id,{...edit,...patch},now),/порядок дат|количество/);
  }
  await assert.rejects(db.changeHistory(813,edit,now),/недоступна/);
  const foreign=dialog(db,env,813);await foreign.cb('history:episode:'+key);assert.match(foreign.result(),/недоступна/);
  assert.deepEqual(await db.streaks(id),before);
  const chat=dialog(db,env,id);
  await chat.cb('history:episode:'+key);await chat.press('Удалить');assert.match(chat.result(),/объединятся/);
  await chat.press('Назад');assert.deepEqual(await db.streaks(id),before);
  await chat.press('Удалить');await chat.press('Подтвердить удаление');assert.match(chat.result(),/Запись удалена/);
  const merged=await db.streaks(id);
  assert.deepEqual({...merged[0]},{...before[1],start:before[0].start});assert.deepEqual(merged[1],before[2]);
  assert.equal(calculate(merged,now).total_seconds-calculate(before,now).total_seconds,86400);
  await assert.rejects(db.changeHistory(id,edit,now),/недоступна/);
  await db.change(id,'cost',{price:'7',currency:'EUR'},now);
  const mixed=await db.streaks(id);
  await chat.cb('history:episode:'+later);await chat.press('Удалить');assert.match(chat.result(),/разные параметры привычки/);
  assert.deepEqual(await db.streaks(id),mixed);
  assert.deepEqual(Object.keys(calculate(mixed,now).money),['RUB','EUR']);
  const competing=await changeFor(db,id,'edit',later,{count:5});
  await db.changeHistory(id,{...competing,count:null},now);
  await assert.rejects(db.changeHistory(id,competing,now),/Запись уже изменилась/);
  assert.equal((await db.streaks(id))[0].lapse_count,null);
});

test('history correction retains earned awards and uncertain delivery markers while releasing definitive failures',async()=>{
  const {db,env}=database();const id=814;
  await db.register(id,id,{...profile,start:at(-45)},now);
  await db.awards(id,now);
  for(const [day,value,status,attempts] of [['2026-11-14',7,'rejected',1],['2026-11-13',14,'rejected',2],['2026-11-12',30,'sent',1],['2026-11-11',3,'unknown',1]]) {
    await db.run('INSERT INTO reports(user_id,local_date,status,created_at,milestone,attempts) VALUES (?,?,?,?,?,?)',id,day,status,at(-1),value,attempts);
  }
  const key=(await db.streaks(id))[0].id,settings=await db.user(id);
  const chat=dialog(db,env,id);await chat.cb('history');await chat.press('Исправить начальную дату');
  await chat.text('15.11.2026 12:00');assert.match(chat.result(),/<b>Было<\/b>[\s\S]+<b>Будет<\/b>/);
  await chat.press('Сохранить изменения');
  assert.equal(Date.parse((await db.streaks(id))[0].start),Date.parse('2026-11-15T09:00Z'));
  assert((await db.awards(id,now)).some(row=>row.days===30));
  assert.deepEqual((await db.all('SELECT milestone FROM reports WHERE user_id=? AND local_date<? ORDER BY local_date',id,'2026-11-16')).map(r=>r.milestone),[3,30,14,null]);
  assert.deepEqual(settings,await db.user(id));assert.equal(zone,settings.timezone);
  await active(db);
  const sent=[];
  const morning=Date.parse('2026-11-23T05:00Z');
  const api=async(_,method,body)=>{if(method==='sendMessage')sent.push(body.text);};
  await tick(env,morning,api);await tick(env,morning+60000,api);
  assert.equal(sent.length,1);assert.match(sent[0],/Целая неделя без сигарет!/);
});

test('webhook history confirmation waits for the Cron lock and cannot duplicate the daily report or apply twice',async()=>{
  const {db,env}=database();const id=815;await active(db);
  const schedule=Date.parse('2026-11-16T09:00Z');
  await db.register(id,id,{...profile,start:at(-22),report_time:'12:00'},now-day);
  const key=await addLapse(db,id,-8,-7,2);
  const change=await changeFor(db,id,'edit',key,{count:8});
  await db.saveState(id,123456,{state:'Form:historyReview',mode:'history',nonce:'test-confirmation',change,timezone:zone});
  let entered,released,deliveries=0;
  const reportStarted=new Promise(resolve=>{entered=resolve;});
  const waitForRelease=new Promise(resolve=>{released=resolve;});
  const api=async(_,method)=>{if(method==='sendMessage'){deliveries++;entered();await waitForRelease;}};
  const cron=tick(env,schedule,api);
  await Promise.race([reportStarted,cron.then(()=>assert.fail('Cron did not send'))]);
  const update=callback(id,8150,'f:test-confirmation:commit',schedule);
  const send=()=>webhook(request(update),env,schedule,async()=>{});
  try {assert.equal((await send()).status,503);}finally {released();await cron;}
  assert.equal((await send()).status,200);assert.equal((await send()).status,200);
  assert.equal((await db.streaks(id))[0].lapse_count,8);
  await tick(env,schedule+60000,api);assert.equal(deliveries,1);
  assert.equal((await db.one("SELECT status FROM reports WHERE user_id=? AND local_date='2026-11-16'",id)).status,'sent');
});

test('collection shows 0/9, 4/9 and 9/9, and a new lapse keeps the complete collection',async()=>{
  const half=awardsReport(23*86400,new Set([1,3,7,14]));
  assert.match(awardsReport(0,new Set()),/0 из 9 наград[\s\S]+▱{10} <b>0%<\/b>[\s\S]+<b>24 часа — Первый день/);
  assert.match(half,/4 из 9 наград[\s\S]+▰{4}▱{6} <b>44%<\/b>[\s\S]+Полученные награды[\s\S]+<b>30 дней — Месяц[\s\S]+7 дней/);
  const {db,env}=database();const id=816;
  await db.register(id,id,{...profile,start:at(-400)},now);
  await addLapse(db,id,-1,-1,1);
  assert.deepEqual(new Set((await db.awards(id,now)).map(row=>row.days)),new Set(milestones));
  const chat=dialog(db,env,id);await chat.cb('awards');assert.match(chat.result(),/9 из 9 наград[\s\S]+▰{10} <b>100%<\/b>[\s\S]+Коллекция собрана/);
  assert.doesNotMatch(chat.result(),/Впереди|До следующей награды/);
  await chat.press('📊 Мой прогресс');assert.match(chat.result(),/Мой прогресс/);
});
