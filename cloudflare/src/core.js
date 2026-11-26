import Decimal from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';
import A from './assets.json' with {type: 'json'};
import {dailyFact} from './health.js';
export {healthReport} from './health.js';
Decimal.set({precision: 28, rounding: Decimal.ROUND_HALF_EVEN});
export { A };
export class ValidationError extends Error {}
export const DEFAULTS={daily:20,price:'250',currency:'RUB',pack:20,minutes:'5',timezone:'Europe/Moscow',report_time:'08:00'};
export const PRIVACY='Сохраняем Telegram ID и ID чата для ответов, настройки курения, даты серий, время и количество сигарет при записи срыва, достижения и отметки отправки для расчётов и защиты от дублей. Имя, телефон и переписку не сохраняем. Ответы в очереди удаляются после завершения отправки; старые записи очищаются периодически. Удаление: /delete. После удаления остаётся только необратимая метка ID с датой удаления, чтобы старые события не восстановили аккаунт. Резервные копии удаляются владельцем отдельно; история восстановления D1 хранится до 7 дней. Утренний отчёт можно выключить в настройках.';
export const milestones = [1,3,7,14,30,60,90,180,365];
export const esc = v => String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;');
export const minute = value => Math.floor(new Date(value).getTime()/60000)*60000;
export const stamp = value => new Date(value).toISOString().replace('Z','000+00:00');
const formatters=new Map(),dueCache=new Map();
function civil(now,zone) {
  let fmt=formatters.get(zone);
  if(!fmt) {
    fmt=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    if(formatters.size>=64)formatters.clear();formatters.set(zone,fmt);
  }
  const p={};for(const v of fmt.formatToParts(new Date(now)))if(v.type!=='literal')p[v.type]=v.value;
  return p;
}
export function local(now,zone) {
  const p=civil(+new Date(now),zone);
  return {day:`${p.year}-${p.month}-${p.day}`,clock:`${p.hour}:${p.minute}`};
}
// 'compatible': spring gap moves forward; autumn overlap uses the first occurrence.
// One report per local calendar date, including both occurrences of an overlap.
export function nextDue(now,zone,clock,afterDay=null) {
  let day=local(now,zone).day;
  const tomorrow=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  if(afterDay&&day<=afterDay)day=tomorrow(afterDay);
  let due=dayDue(day,zone,clock);
  if(due<=+new Date(now))due=dayDue(tomorrow(day),zone,clock);
  return due;
}
export function dayDue(day,zone,clock) {
  const key=`${zone}|${day}|${clock}`;
  if(dueCache.has(key))return dueCache.get(key);
  const wall=Date.parse(`${day}T${clock}:00Z`);
  const wallAt=ms=>{const p=civil(ms,zone);return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);};
  // Probe both sides of a transition, including half-hour DST and date-line gaps.
  const offsets=new Set([-36,0,36].map(h=>{const t=wall+h*3600000;return wallAt(t)-t;}));
  const candidates=[...offsets].map(offset=>wall-offset).sort((a,b)=>a-b);
  const exact=candidates.filter(ms=>wallAt(ms)===wall);
  const due=exact.length?exact[0]:candidates.filter(ms=>wallAt(ms)>wall).sort((a,b)=>wallAt(a)-wallAt(b))[0];
  if(!Number.isFinite(due))throw new ValidationError('Не удалось рассчитать время уведомления.');
  if(dueCache.size>=1024)dueCache.clear();dueCache.set(key,due);return due;
}
export function parseDate(text,zone,now=Date.now(),provisional=false) {
  if (['сейчас','только что'].includes(text.toLowerCase())) return stamp(minute(now));
  const m = /^(?:(\d{1,2})\.(\d{1,2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2}))(?: +|T)(\d{1,2}):(\d{2})(?:\s+([+-]\d{4}))?$/.exec(text);
  if (!m) throw new ValidationError('Введи дату и время, например 15.11.2026 21:30, или выбери «Сейчас».');
  const [day,month,year,hour,min] = [m[1]??m[6],m[2]??m[5],m[3]??m[4],m[7],m[8]].map(Number);
  if(year<1900) throw new ValidationError('Укажи дату начиная с 1900 года.');
  let p;
  try { p = Temporal.PlainDateTime.from({year,month,day,hour,minute:min}, {overflow:'reject'}); }
  catch { throw new ValidationError('Такой даты или времени нет. Проверь ввод или выбери «Сейчас».'); }
  let ms;
  if(provisional && !m[9]) ms=Number(p.toZonedDateTime('+14:00').epochMilliseconds);
  else if(m[9]) {
    const offset=m[9].slice(0,3)+':'+m[9].slice(3);
    try {ms=Number(p.toZonedDateTime(offset).epochMilliseconds);}
    catch {throw new ValidationError('Укажи допустимое смещение UTC, например +0300.');}
    if(!provisional && !Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime().equals(p)) throw new ValidationError('Смещение UTC не соответствует выбранному часовому поясу.');
  } else {
    try { ms=Number(p.toZonedDateTime(zone,{disambiguation:'reject'}).epochMilliseconds); }
    catch { throw new ValidationError('Время отсутствует или неоднозначно из-за перевода часов. Выбери другое время или укажи смещение, например +0200 или +0100.'); }
  }
  if(minute(ms)>minute(now)) throw new ValidationError('Последняя сигарета не может быть в будущем.');
  return stamp(ms);
}
export function numeric(text,lower,upper,integer=false) {
  if(!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(text)) throw new ValidationError('Введи число (не больше двух знаков после запятой).');
  const n=new Decimal(text.replace(',','.'));
  if(n.lt(lower)||n.gt(upper)) throw new ValidationError(`Допустимо от ${lower} до ${upper}.`);
  if(integer&&!n.isInteger()) throw new ValidationError('Введи целое число.');
  return integer?n.toNumber():text.replace(',','.').replace(/^0+(?=\d)/,'');
}
export function parseField(field,text,zone,now=Date.now()) {
  if(['start','lapse_begin','lapse_last'].includes(field)) return parseDate(text,zone,now);
  if(field==='daily') return numeric(text,1,200,true);
  if(field==='pack') return numeric(text,1,100,true);
  if(field==='minutes') return numeric(text,'0.1',120);
  if(field==='cost') {
    const p=text.toUpperCase().replaceAll('₽',' RUB').replaceAll('€',' EUR').replaceAll('$',' USD').trim().split(/\s+/);
    const currency=p[1]||DEFAULTS.currency;
    if(p.length>2||! /^[A-Z]{3}$/.test(currency)) throw new ValidationError('Введи цену и валюту через пробел, например 250 ₽ или 5,50 EUR.');
    return {price:numeric(p[0],'0.01',1000000), currency};
  }
  if(field==='timezone') {try {local(now,text);} catch {throw new ValidationError('Неизвестный пояс. Пример: Europe/Moscow или Asia/Yekaterinburg.');} return text;}
  if(field==='report_time') {
    const m=/^(\d{1,2}):(\d{2})$/.exec(text);
    if(!m||+m[1]>23||+m[2]>59) throw new ValidationError('Введи время от 0:00 до 23:59, например 6:00 или 18:30.');
    return m[1].padStart(2,'0')+':'+m[2];
  }
  throw new ValidationError('Неизвестное поле.');
}
export function calculate(streaks,now) {
  const s={current_seconds:0,total_seconds:0,cigarettes:new Decimal(0),money:{},free_minutes:new Decimal(0)};
  for(const p of streaks) {
    const sec=Math.max(0,Math.floor((Math.min(p.end?+new Date(p.end):+new Date(now),+new Date(now))-new Date(p.start))/1000));
    s.total_seconds+=sec;
    if(!p.end) s.current_seconds=sec;
    const n=new Decimal(sec).mul(p.daily).div(86400);
    s.cigarettes=s.cigarettes.add(n);
    s.money[p.currency]=(s.money[p.currency]||new Decimal(0)).add(n.mul(p.price).div(p.pack));
    s.free_minutes=s.free_minutes.add(n.mul(p.minutes));
  }
  s.life_minutes=s.cigarettes.mul(20);
  return s;
}
const integer = n => n.toFixed(0,Decimal.ROUND_HALF_UP).replace(/\B(?=(\d{3})+(?!\d))/g,' ');
const plural = (n,one,few,many) => n%10===1&&n%100!==11?one:n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?few:many;
export function compactDuration(seconds,words=false) {
  const minutes=Math.floor(Math.max(0,seconds)/60),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
  const parts=[];
  if(days) parts.push(`${days} ${words?plural(days,'день','дня','дней'):'дн.'}`);
  if(hours) parts.push(`${hours} ${words?plural(hours,'час','часа','часов'):'ч.'}`);
  if(!days&&minutes%60) parts.push(`${minutes%60} ${words?plural(minutes%60,'минута','минуты','минут'):'мин.'}`);
  return parts.join(' ')||'меньше минуты';
}

const day=86400;
const awards={
  1:['🌱','Первый день','Первый день без сигарет!'],
  3:['🔥','Три дня','Три дня без сигарет!'],
  7:['🥉','Первая неделя','Целая неделя без сигарет!'],
  14:['🥈','Две недели','Две недели без сигарет!'],
  30:['🥇','Месяц','Месяц без сигарет!'],
  60:['🎖','Два месяца','Два месяца без сигарет!'],
  90:['💎','Три месяца','Три месяца без сигарет!'],
  180:['🌟','Полгода','Полгода без сигарет!'],
  365:['👑','Год','Целый год без сигарет!']
};
const daysText=d=>compactDuration(d*day,true);
export const currencySymbol=currency=>({RUB:'₽',USD:'$',EUR:'€'})[currency]||currency;
export const dateLabel=(value,zone)=>{
  const {day,clock}=local(value,zone);
  return day.split('-').reverse().join('.')+' '+clock;
};
export const cities={
  'Europe/Moscow':'Москва','Europe/Kaliningrad':'Калининград','Asia/Yekaterinburg':'Екатеринбург',
  'Asia/Novosibirsk':'Новосибирск','Asia/Vladivostok':'Владивосток','Europe/Berlin':'Берлин'
};
export const zoneLabel=zone=>Object.hasOwn(cities,zone)?cities[zone]:zone;
export const lastMilestone=seconds=>seconds>=365*day
  ?Math.floor(seconds/(365*day))*365
  :milestones.findLast(d=>seconds>=d*day)??0;
function goal(seconds) {
  const from=lastMilestone(seconds);
  const next=milestones.find(d=>seconds<d*day)??from+365;
  const elapsed=seconds-from*day,total=(next-from)*day;
  const percent=Math.min(99,Math.round(elapsed*100/total)),cells=Math.min(9,Math.round(elapsed*10/total));
  return {next,left:compactDuration(next*day-seconds,true),bar:`${'▓'.repeat(cells)}${'░'.repeat(10-cells)} ${percent}%`};
}
const series=(seconds)=>`🚭 <b>${compactDuration(seconds,true)} без сигарет</b>`;
function totals(s,timeLabel='Свободного времени') {
  const money=Object.entries(s.money).map(([currency,value])=>`${integer(value)} ${esc(currencySymbol(currency))}`).join(' + ');
  return `🚬 Не выкурено: ${integer(s.cigarettes)} шт.\n💰 Сэкономлено: ${money}\n⏳ ${timeLabel}: ${compactDuration(s.free_minutes.mul(60).toNumber())}`;
}
export function morningReport(s,localDay,id,milestone=0) {
  const {next,left,bar}=goal(s.current_seconds);
  const fact=`✨ <b>Факт дня</b>\n\n${dailyFact(s.current_seconds,localDay,id)}`;
  if(milestone) return `🏆 <b>${awards[milestone]?.[2]??daysText(milestone)+' без сигарет!'}</b>\n\n`+
    `🚭 ${daysText(milestone)} — новый рубеж!\n\n${totals(s)}\n\n${fact}\n\n🎯 Следующая цель — ${daysText(next)}.`;
  return `${series(s.current_seconds)}\n\n🎯 До ${next} ${plural(next,'дня','дней','дней')} — ${left}\n${bar}\n\n${totals(s)}\n\n${fact}`;
}
export function progressReport(s,earned) {
  const {next,bar}=goal(s.current_seconds),locked=milestones.find(d=>!earned.has(d));
  const history=milestones.filter(d=>earned.has(d)).slice(-3).map(d=>'✅ '+awards[d][1]);
  if(locked)history.push(`🔒 ${awards[locked][1]} — следующая награда`);
  const life=s.life_minutes.mul(60).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();
  const total=s.total_seconds>s.current_seconds?`\n📅 Всего без сигарет: ${compactDuration(s.total_seconds,true)}`:'';
  return `<b>📊 Мой прогресс</b>\n\n${series(s.current_seconds)}\n\n🎯 Следующая цель — ${daysText(next)}\n${bar}\n\n${totals(s)}\n`+
    `❤️ Статистический эквивалент жизни: ≈${compactDuration(life,true)}${total}\n\n<b>🏆 Мои достижения</b>\n\n${history.join('\n')}`;
}
export function awardsReport(seconds,earned) {
  const locked=milestones.find(d=>!earned.has(d));
  const collection=milestones.map(d=>`${earned.has(d)?awards[d][0]:'🔒'} ${awards[d][1]}`).join('\n');
  const next=locked?`🎯 Следующая награда — ${awards[locked][1]}\n⏳ До неё — ${compactDuration(locked*day-seconds,true)}`:'Все награды получены! 🎉';
  return `<b>🏆 Все достижения</b>\n\nПолучено: ${earned.size} из ${milestones.length}\n\n${collection}\n\n${next}`;
}
export function cravingReport(s) {
  return `<b>🆘 Хочу закурить</b>\n\n${series(s.current_seconds)}\n\n${totals(s,'Освобождено')}\n\n`+
    '💧 Выпей воды или немного пройдись. Дай себе 5 минут.\n\n<b>Не нужно решать «навсегда». Просто не кури сейчас.</b>';
}
export const buttons=(...rows)=>({inline_keyboard:rows.map(row=>row.map(([text,callback_data])=>({text,callback_data})))});
export const reportButtons=()=>buttons([['🫁 Здоровье','report:health'],['ℹ️ Как считаем','report:methodology']]);
export function methodologyReport(detailed=false) {
  const title='<b>ℹ️ Как считаем</b>';
  if(!detailed)return [
    title,'Все показатели рассчитываются автоматически по твоим настройкам и времени без сигарет.',
    '🚬 Не выкурено — по прежней привычке.',
    '💰 Сэкономлено — по цене пачки.',
    '⏳ Свободное время — по длительности перекуров.',
    '❤️ Эквивалент жизни — по статистической модели.'
  ].join('\n\n');

  return [
    title,
    'Не выкурено ≈ секунды без курения / 86 400 × прежние сигареты в день.',
    'Сэкономлено ≈ не выкурено × цена пачки / сигарет в пачке. Суммы в разных валютах показываем отдельно.',
    'Свободное время ≈ не выкурено × минуты на перекур.',
    'Эквивалент жизни ≈ не выкурено × 20 минут. '+A.MODEL_NOTE+` <a href="${A.ADDICTION}">Исследование</a>`,
    'Итоги складываются из всех бездымных периодов. Промежутки срыва исключены. Изменение настроек пересчитывает текущую серию. Сигареты и деньги округляются при показе.',
    'Шкала показывает долю пути от предыдущего рубежа до следующего. При достижении рубежа начинается новый отрезок.'
  ].join('\n\n');
}
export const menu=()=>({keyboard:[[0,1],[2,3],[4]].map(row=>row.map(i=>({text:A.MENU_LABELS[i]}))),resize_keyboard:true});
export const choices=(...labels)=>({
  keyboard:[...(labels.length?[labels.map(text=>({text}))]:[]),[{text:'Отмена'}]],
  resize_keyboard:true,one_time_keyboard:true
});
export const settings=()=>buttons(
  [['🚭 Дата отказа','edit:start']],
  [['🚬 Привычка','edit:daily'],['📦 Размер пачки','edit:pack']],
  [['💰 Стоимость','edit:cost'],['⏰ Уведомления','notifications']],
  [['🌍 Часовой пояс','edit:timezone'],['⏳ Минут на сигарету','edit:minutes']],
  [['🚬 Отметить срыв','lapse']],[['🗑 Удалить мои данные','delete']]
);
export const confirmation=nonce=>buttons([['Подтвердить срыв',`lapse:confirm:${nonce}`],['Отмена','cancel']]);
