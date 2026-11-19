import Decimal from 'decimal.js';
import { Temporal } from '@js-temporal/polyfill';
import A from './assets.json' with {type: 'json'};
Decimal.set({precision: 28, rounding: Decimal.ROUND_HALF_EVEN});
export { A };
export const milestones = [1,3,7,14,30,60,90,180,365];
export const esc = v => String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;');
export const minute = value => Math.floor(new Date(value).getTime()/60000)*60000;
export const stamp = value => new Date(value).toISOString().replace('Z','000+00:00');
export function local(now,zone) {
  const d = Temporal.Instant.fromEpochMilliseconds(+new Date(now)).toZonedDateTimeISO(zone);
  return {day: d.toPlainDate().toString(), clock: `${String(d.hour).padStart(2,'0')}:${String(d.minute).padStart(2,'0')}`, d};
}
export function parseDate(text,zone,now=Date.now(),provisional=false) {
  if (['сейчас','только что'].includes(text.toLowerCase())) return stamp(minute(now));
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?: ([+-]\d{4}))?$/.exec(text);
  if (!m) throw Error('Введите ДД.ММ.ГГГГ ЧЧ:ММ, например 15.11.2026 21:30, или «Сейчас».');
  const [day,month,year,hour,min] = [m[1],m[2],m[3],m[4],m[5]].map(Number);
  if(year<1900) throw Error('Укажите дату начиная с 1900 года.');
  let p;
  try { p = Temporal.PlainDateTime.from({year,month,day,hour,minute:min}, {overflow:'reject'}); }
  catch { throw Error('Введите дату ДД.ММ.ГГГГ ЧЧ:ММ или нажмите «Сейчас».'); }
  let ms;
  if(provisional && !m[6]) ms=Number(p.toZonedDateTime('+14:00').epochMilliseconds);
  else if(m[6]) {
    const offset=m[6].slice(0,3)+':'+m[6].slice(3);
    ms=Number(p.toZonedDateTime(offset).epochMilliseconds);
    if(!provisional && !Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime().equals(p)) throw Error('Смещение UTC не соответствует выбранному часовому поясу.');
  } else {
    try { ms=Number(p.toZonedDateTime(zone,{disambiguation:'reject'}).epochMilliseconds); }
    catch { throw Error('Время отсутствует или неоднозначно из-за перевода часов. Добавьте смещение, например +0200 или +0100.'); }
  }
  if(minute(ms)>minute(now)) throw Error('Последняя сигарета не может быть в будущем.');
  return stamp(ms);
}
export function numeric(text,lower,upper,integer=false) {
  if(!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(text)) throw Error('Введите число (не больше двух знаков после запятой).');
  const n=new Decimal(text.replace(',','.'));
  if(n.lt(lower)||n.gt(upper)) throw Error(`Допустимо от ${lower} до ${upper}.`);
  if(integer&&!n.isInteger()) throw Error('Введите целое число.');
  return integer?n.toNumber():text.replace(',','.').replace(/^0+(?=\d)/,'');
}
export function parseField(field,text,zone,now=Date.now()) {
  if(['start','lapse_begin','lapse_last'].includes(field)) return parseDate(text,zone,now);
  if(field==='daily') return numeric(text,1,200,true);
  if(field==='pack') return numeric(text,1,100,true);
  if(field==='minutes') return numeric(text,'0.1',120);
  if(field==='cost') {
    const p=text.toUpperCase().replaceAll('₽','RUB').replaceAll('€','EUR').replaceAll('$','USD').split(/\s+/);
    if(p.length!==2||! /^[A-Z]{3}$/.test(p[1])) throw Error('Введите цену и валюту через пробел, например 250 RUB или 5,50 EUR.');
    return {price:numeric(p[0],'0.01',1000000), currency:p[1]};
  }
  if(field==='timezone') {try {local(now,text);} catch {throw Error('Неизвестный пояс. Пример: Europe/Moscow или Asia/Yekaterinburg.');} return text;}
  if(field==='report_time') {
    const m=/^(\d{1,2}):(\d{2})$/.exec(text);
    if(!m) throw Error('Введите время в формате ЧЧ:ММ, например 08:00.');
    if(+m[1]>23||+m[2]>59) throw Error('Часы: 00–23, минуты: 00–59.');
    return m[1].padStart(2,'0')+':'+m[2];
  }
  throw Error('Неизвестное поле.');
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
export function duration(seconds) {
  const m=Math.floor(Math.max(0,seconds)/60);
  return `${Math.floor(m/1440)} дн. ${Math.floor(m%1440/60)} ч. ${m%60} мин.`;
}
const number = n => n.toFixed(2,Decimal.ROUND_HALF_UP).replace(/\B(?=(\d{3})+(?!\d))/g,' ').replace('.',',');
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
export function morningReport(streaks,now) {
  // One supplied instant for the series, target and all model estimates.
  const s=calculate(streaks,now);
  const next=milestones.find(d=>s.current_seconds<d*86400)??(Math.floor(s.current_seconds/(365*86400))+1)*365;
  const ratio=Math.max(0,Math.min(1,s.current_seconds/(next*86400)));
  const filled=Math.min(10,Math.floor(ratio*10)),percent=Math.min(100,Math.floor(ratio*100));
  const symbols={RUB:'₽',USD:'$',EUR:'€'};
  const money=Object.entries(s.money).map(([currency,value])=>`${integer(value)} ${esc(symbols[currency]||currency)}`).join(' + ')||'0';
  return `🚭 <b>${compactDuration(s.current_seconds,true)} без сигарет</b>\n\n`+
    `🎯 До ${next} ${plural(next,'дня','дней','дней')} — ${compactDuration(next*86400-s.current_seconds,true)}\n`+
    `${'▓'.repeat(filled)}${'░'.repeat(10-filled)} ${percent}%\n\n`+
    `🚬 Не выкурено: ~${integer(s.cigarettes)} шт.\n`+
    `💰 Сэкономлено: ~${money}\n`+
    `⏳ Без перекуров: ~${compactDuration(s.free_minutes.mul(60).toNumber())}`;
}
export const reportButtons=()=>({inline_keyboard:[[
  {text:'🫁 Здоровье',callback_data:'report:health'},
  {text:'ℹ️ Методика',callback_data:'report:methodology'}
]]});
export function healthReport(seconds) {
  const reached=A.STAGES.filter(s=>seconds>=s.seconds),next=A.STAGES.find(s=>seconds<s.seconds);
  const line=s=>`${s.label}: ${s.text} <a href="${s.source}">Источник</a>`;
  return ['<b>🫁 Здоровье</b>','Ориентиры по длительности текущей серии; наступление изменений у вас не измеряется.','',
    '<b>Достигнутые временные ориентиры</b>',...reached.map(s=>'✓ '+line(s)),
    ...(!reached.length?['Пока нет достигнутых ориентиров.']:[]),'','<b>Ближайший ориентир</b>',
    next?line(next):'Все ориентиры календаря пройдены по времени.','',A.HEALTH_NOTE].join('\n');
}
export function methodologyReport() {
  return ['<b>ℹ️ Методика</b>',
    'Все показатели отчёта рассчитаны на один момент времени. Текущая серия — время с последней сигареты; после срыва начинается заново. Цель — следующий этап текущей серии, шкала — доля времени от её начала до цели.',
    'Не выкурено ≈ сумма (секунды без курения / 86 400 × прежние сигареты в день).',
    'Сэкономлено ≈ сумма (не выкурено × цена пачки / сигарет в пачке). Валюты учитываются отдельно, без конвертации.',
    'Без перекуров ≈ сумма (не выкурено × прежние минуты на сигарету).',
    'Суммы учитывают все бездымные периоды; промежутки срыва исключены. Завершённые периоды сохраняют свои параметры. Изменение расхода, цены и длительности пересчитывает текущую серию.',
    'Сигареты и деньги округляются до целых только при показе утром. Время показывается без нулевых частей, от суток — дни и часы без минут. Полные показатели: «📊 Мой прогресс».',
    'Это статистические оценки по прежним привычкам, а не измерение фактических покупок, состояния здоровья или личной продолжительности жизни.','',
    A.MODEL_NOTE+` <a href="${A.ADDICTION}">Исследование</a>`,'',A.HEALTH_NOTE,'',
    '<b>Источники медицинских ориентиров</b>',...Array.from(new Set(A.STAGES.map(s=>s.source))).map(url=>`<a href="${url}">${new URL(url).hostname}</a>`)
  ].join('\n\n');
}
export function stageLine(sec) {
  const s=A.STAGES.findLast(s=>sec>=s.seconds);
  return s?`${s.label}: ${s.text} <a href="${s.source}">Источник</a>`:'Первые изменения начинаются вскоре после отказа. Ближайший ориентир — около 20 минут.';
}
export function report(streaks,now,day,id,morning=false) {
  if(morning) return morningReport(streaks,now);
  const s=calculate(streaks,now), index=Math.floor(Date.parse(day)/86400000)+719163+id;
  const title=morning?A.GREETINGS[index%A.GREETINGS.length]:'Ваш прогресс';
  const money=Object.entries(s.money).map(([k,v])=>`${number(v)} ${esc(k)}`).join(' + ');
  const next=milestones.find(d=>s.current_seconds<d*86400)??(Math.floor(s.current_seconds/(365*86400))+1)*365;
  return `<b>🚭 НЕ КУРЮ · ${title}</b>\n${day.split('-').reverse().join('.')}\n\n`+
    `🚭 Текущая серия: <b>${duration(s.current_seconds)}</b>\n`+
    `📅 Всего в учтённых бездымных периодах: ${duration(s.total_seconds)}\n`+
    `🚬 Не выкурено, оценка: <b>≈ ${number(s.cigarettes)}</b>\n`+
    `💰 Сэкономлено, оценка: <b>≈ ${money}</b>\n`+
    `⏳ Без перекуров: ≈ ${duration(s.free_minutes.mul(60).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber())}\n`+
    `❤️ Статистический эквивалент: ≈ ${duration(s.life_minutes.mul(60).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber())}\n`+
    `<i>${A.MODEL_NOTE}</i> <a href="${A.ADDICTION}">Исследование</a>\n\n`+
    `🫁 <b>Ориентир для текущей серии</b>\n${stageLine(s.current_seconds)}\n`+
    `<i>Сроки индивидуальны, это не медицинская гарантия.</i>\n\n`+
    `🎯 ${next} дн. в текущей серии — осталось ${duration(next*86400-s.current_seconds)}\n\n`+
    `💬 ${A.THOUGHTS[index%A.THOUGHTS.length]}\n\n`+
    '<i>Итоги — модель по прежнему расходу во всех бездымных периодах. Промежуток срыва исключён; фактические расходы и здоровье модель не измеряет.</i>';
}
export const menu=()=>({keyboard:[[0,1],[2,3],[4]].map(row=>row.map(i=>({text:A.MENU_LABELS[i]}))),resize_keyboard:true});
export const choices=field=>({keyboard:[...A.CHOICES[field].map(text=>[{text}]),[{text:'Отмена'}]],resize_keyboard:true,input_field_placeholder:'Введите ответ или нажмите кнопку'});
export const settings=()=>({inline_keyboard:[...A.FIELDS.map(f=>[{text:A.LABELS[f],callback_data:`edit:${f}`}]),[{text:'↩️ Отметить срыв',callback_data:'lapse'}]]});
export const confirmation=nonce=>({inline_keyboard:[[{text:'Подтвердить срыв',callback_data:`lapse:confirm:${nonce}`},{text:'Отмена',callback_data:'cancel'}]]});
export const original = prefix => {const text=A.TEXTS.find(t=>t.startsWith(prefix));if(!text)throw Error('Missing original text');return text;};
