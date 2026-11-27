import {compactDuration,dateLabel,esc,ValidationError,zoneLabel} from './core.js';

const habitFields=['daily','price','currency','pack','minutes'];
const date=(value,zone)=>dateLabel(value,zone).replace(' ', ', ');
const elapsed=(start,end)=>compactDuration(Math.max(0,(new Date(end)-new Date(start))/1000),true);
export function historyTarget(rows,kind,key) {
  const index=rows.findIndex(row=>row.id===key);
  const first=rows[index],second=rows[index+1];
  if(!first||(kind==='initial'?index!==0:!first.end||!second))throw new ValidationError('Запись уже изменилась или недоступна. Открой историю заново.');
  return {first,second:kind==='initial'?undefined:second,index};
}
export const historySnapshot=({first,second})=>JSON.stringify([first,second].map(row=>row&&[
  row.id,row.start,row.end,row.lapse_count,...habitFields.map(field=>row[field])
]));

export function validateHistoryChange(rows,change,now) {
  const {first,second}=historyTarget(rows,change.kind,change.key);
  if(change.snapshot!==historySnapshot({first,second}))throw new ValidationError('Запись уже изменилась. Открой историю заново.');
  const instant=value=>Date.parse(value);
  const valid=value=>Number.isFinite(value)&&value<=now;
  if(change.kind==='initial') {
    const start=instant(change.start);
    if(!valid(start)||(first.end&&start>instant(first.end)))throw new ValidationError('Начало отслеживания должно быть не позже первого срыва и не в будущем.');
    return {first,updated:{...first,start:change.start}};
  }
  const begin=instant(change.kind==='remove'?first.end:change.begin);
  const last=instant(change.kind==='remove'?second.start:change.last);
  if(!valid(begin)||!valid(last)||!valid(instant(first.start))||begin<instant(first.start)||last<begin||
    (second.end&&(!valid(instant(second.end))||last>instant(second.end)))) {
    throw new ValidationError('Проверь порядок дат. Срыв должен быть между соседними границами серий, а даты не могут быть в будущем.');
  }
  if(change.kind==='remove') {
    if(!habitFields.every(field=>first[field]===second[field]))throw new ValidationError('Этот срыв нельзя удалить: у соседних серий разные параметры привычки. При объединении потерялись бы исторические данные. Даты и количество можно исправить.');
    return {first,second,updated:{...second,start:first.start}};
  }
  if(change.kind!=='edit'||(change.count!==null&&(!Number.isSafeInteger(change.count)||change.count<1||change.count>10000))) {
    throw new ValidationError('Укажи количество от 1 до 10 000 или оставь его неизвестным.');
  }
  return {first,second,updated:{...first,end:change.begin,lapse_count:change.count},following:{...second,start:change.last}};
}

export function historyReport(rows,zone,now) {
  const active=rows.at(-1),count=rows.filter(row=>row.end).length;
  return ['📅 <b>История прогресса</b>',`🌍 Часовой пояс: ${esc(zoneLabel(zone))}`,
    `<b>Текущая серия:</b> ${elapsed(active.start,now)}`,
    `<b>Начало отслеживания:</b> ${date(rows[0].start,zone)}`,
    count?`Зарегистрировано срывов: <b>${count}</b>`:'Срывов не зарегистрировано.'].join('\n\n');
}
export const episodeFields=(begin,last,count,zone)=>[
  `Первая сигарета: ${begin?date(begin,zone):'не указана'}`,
  `Последняя сигарета: ${date(last,zone)}`,
  `Количество сигарет: ${count??'не указано'}`
].join('\n');
export const episodeReport=({first,second,index},zone)=>
  `📅 <b>Срыв №${index+1}</b>\n\n${episodeFields(first.end,second.start,first.lapse_count,zone)}`;
export const seriesReport=(row,zone,now)=>
  `${row.end?'⚪ <b>Завершённая серия</b>':'🟢 <b>Текущая серия</b>'}\n<b>${elapsed(row.start,row.end||now)}</b>\n${date(row.start,zone)} → ${row.end?date(row.end,zone):'сейчас'}`;
