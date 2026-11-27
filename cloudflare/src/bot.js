import {
  A,esc,minute,stamp,local,parseDate,parseField,numeric,calculate,morningReport,compactDuration,
  methodologyReport,progressReport,detailedProgressReport,awardsReport,menu,buttons,
  dateLabel,zoneLabel,cities,currencySymbol,DEFAULTS,PRIVACY,RECOVERY_LABEL,ValidationError
} from './core.js';
import {healthReport,healthCards,stages,currentStage,healthNote,stageCards,generalSources} from './health.js';
import {cravingCategories} from './craving.js';
import {historyReport,seriesReport,episodeReport,episodeFields,historyTarget,historySnapshot,validateHistoryChange} from './history.js';
export class DeliveryError extends Error {constructor(code,retry=0){super(`Telegram ${code}`);this.code=code;this.retry=retry;}}
export async function telegram(env,method,body) {
  // Never propagate fetch errors: they may contain the token-bearing URL.
  let response;
  try {response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
  catch {throw new DeliveryError(0);}
  let data;
  try {data=await response.json();} catch {throw new DeliveryError(0);}
  if(!response.ok||!data.ok) throw new DeliveryError(data.error_code||response.status,data.parameters?.retry_after||0);
  return data.result;
}

const registerSteps=['start','daily','cost','timezone'];
const reportTimes=['06:00','07:00','08:00','09:00','10:00','12:00'];
const timezones=Object.keys(cities);
const nonce=()=>crypto.randomUUID().replaceAll('-','');
const historyPageSize=5;
const formPrompts={
  daily:'Сколько сигарет в день было обычно?',
  cost:'Сколько стоила пачка? Например, 250 ₽ или 5,50 EUR. Если указать только сумму, считаем в ₽.',
  timezone:'В каком часовом поясе считать твой прогресс? Выбери город в своём поясе.',
  lapse_begin:'Когда была первая сигарета после отказа?',
  lapse_count:'Сколько сигарет было выкурено?',
  lapse_last:'Когда была последняя сигарета? С этого момента начнётся новая серия.'
};
const dateInput='Введи дату и время, например 26.11.2026 6:00.';
const timeInput='Введи время, например 6:00 или 18:30.';
const relativeDate=(clock,zone,{at,days})=>
  new Date(Date.parse(local(at,zone).day+'T00:00Z')-days*86400000).toISOString().slice(0,10)+' '+clock;
const zoneChoice=(zone,now)=>{
  const offset=new Intl.DateTimeFormat('en',{timeZone:zone,timeZoneName:'shortOffset'}).formatToParts(now).find(part=>part.type==='timeZoneName').value;
  return `${zoneLabel(zone)} (${offset.replace('GMT','UTC')})`;
};
function parseZone(text,now) {
  const name=text.toLowerCase();
  const query=name.replaceAll(' ','_');
  const named=timezones.find(zone=>cities[zone].toLowerCase()===name);
  const candidates=named||text.includes('/')?[]:Intl.supportedValuesOf('timeZone').filter(zone=>zone.split('/').at(-1).toLowerCase()===query);
  return parseField('timezone',named||(candidates.length===1?candidates[0]:text),DEFAULTS.timezone,now);
}
const habitSummary=user=>[
  `🚬 Прежняя привычка: <b>${user.daily} шт. в день</b>`,
  `💰 Стоимость пачки: <b>${esc(user.price)} ${esc(currencySymbol(user.currency))}</b>`,
  `📦 Сигарет в пачке: <b>${user.pack}</b>`,
  `⏳ Продолжительность перекура: <b>${esc(user.minutes)} мин.</b>`
].join('\n');
const habitFields=['daily','cost','pack','minutes'];
const notificationSummary=user=>`🔔 Подписка: <b>${user.enabled?'включена':'выключена'}</b>\n`+
  `🕒 ${user.enabled?'Время отчёта':'Предпочтительное время'}: ${user.report_time}\n🌍 Часовой пояс: ${esc(zoneLabel(user.timezone))}`;

export async function handleUpdate(update,db,env,now=Date.now(),api=telegram) {
  const cb=update.callback_query,m=cb?.message||update.message;
  if(!m||m.chat.type!=='private') return;
  const id=(cb?.from||m.from).id,botId=Number(env.BOT_TOKEN.split(':')[0]);
  let data=await db.state(id,botId),user=await db.user(id);
  const send=(text,reply_markup)=>api(env,'sendMessage',{chat_id:m.chat.id,text,reply_markup,parse_mode:'HTML',link_preview_options:{is_disabled:true}});
  const save=async next=>{data=next;await db.saveState(id,botId,next);};
  const clear=()=>save({});
  const pick=(label,action)=>[label,`f:${data.nonce}:${action}`];
  const nav=()=>[pick('Назад','back'),pick('Отмена','cancel'),pick('Главное меню','home')];
  const welcome=async()=>{
    await save({state:'Form:welcome',nonce:nonce()});
    return send('<b>🚭 НЕ КУРЮ</b>\n\nКаждый день без сигарет — часть твоего пути.\n\nСледи за прогрессом, замечай положительные изменения и получай поддержку, когда она нужна.\n\nБесплатно. Без рекламы. Без осуждения.',
      buttons([pick('🚭 Начать','begin')],[['🔐 О моих данных','privacy']]));
  };
  const cancel=async()=>{
    if(!user)return welcome();
    if(data.mode==='history')return exitHistory();
    if(data.mode==='edit'||(data.mode==='notify'&&!data.offer)||data.fromAbout)return leaveSettingsForm('Ввод отменён.');
    await clear();return send('Ввод отменён.',menu());
  };
  const stats=async()=>calculate(await db.streaks(id),now);
  const earned=async()=>new Set((await db.awards(id,now)).map(a=>a.days));
  const progressLink=[[A.MENU_LABELS[0],'progress']];
  const methodLink=[['ℹ️ Как считаем','report:methodology']];
  const progress=async()=>send(progressReport(await stats(),await earned()),buttons(
    [['📊 Подробная статистика','progress:details']],[['📅 История','history'],...methodLink],[['📝 Отметить срыв','lapse']]
  ));
  const detailedProgress=async()=>send(detailedProgressReport(await stats(),await earned()),buttons(methodLink,progressLink));
  const home=async()=>{
    if(!user)return welcome();
    await clear();await send('🚭 <b>НЕ КУРЮ</b>',menu());return progress();
  };
  const achievements=async()=>send(awardsReport((await stats()).current_seconds,await earned()),buttons([['📊 Мой прогресс','progress']]));
  const lapseLink=[['📝 Отметить срыв','lapse']];
  const reliefLink=['✅ Отпустило','craving:passed'];
  const craving=()=>send('🆘 <b>Хочется закурить?</b>\n\nЖелание закурить может возникнуть автоматически, особенно в привычной обстановке.\n\nЧто сейчас происходит?',buttons(
    ...Object.entries(cravingCategories).map(([key,[label]])=>[[label,`craving:tip:${key}:0`]]),
    [reliefLink],lapseLink,[['Назад','progress']]));
  const cravingTip=async(key,index)=>{
    if(!Object.hasOwn(cravingCategories,key))return craving();
    const [label,tips]=cravingCategories[key];
    if(index>=tips.length)return craving();
    return send(`<b>${label}</b>\n\n<b>Попробуй сейчас</b>\n${tips[index]}\n\n🚭 <b>${compactDuration((await stats()).current_seconds,true)} без сигарет</b>`,buttons(
      [reliefLink,['💡 Другой совет',`craving:tip:${key}:${(index+1)%tips.length}`]],lapseLink,[['Назад','craving']]));
  };
  const showHistory=async(returnTo='progress')=>{
    const rows=await db.streaks(id);
    if(!rows.length)return send('История пока недоступна.',buttons(progressLink));
    return send(historyReport(rows,user.timezone,now),buttons(
      [['Исправить начальную дату','history:initial']],
      ...(rows.length>1?[[['Срывы','history:lapses:0']]]:[]),
      [['📝 Отметить срыв','lapse']], [['Серии без сигарет','history:series:0']], [['Назад',returnTo]]));
  };
  const historyPage=async(kind,requested)=>{
    const rows=await db.streaks(id),series=kind==='series';
    const items=(series?rows:rows.slice(0,-1)).map((row,index)=>({row,index})).reverse();
    const last=Math.max(0,Math.ceil(items.length/historyPageSize)-1);
    const page=Math.min(last,Math.max(0,requested)),itemsOnPage=items.slice(page*historyPageSize,(page+1)*historyPageSize);
    const text=series?itemsOnPage.map(({row})=>seriesReport(row,user.timezone,now)).join('\n\n')
      :itemsOnPage.map(({row,index})=>episodeReport({first:row,second:rows[index+1],index},user.timezone)).join('\n\n');
    const controls=[];
    if(page)controls.push(['←',`history:${kind}:${page-1}`]);
    if(page<last)controls.push(['→',`history:${kind}:${page+1}`]);
    return send(`📅 <b>${series?'Серии без сигарет':'Срывы'}</b>\n\n${text||(series?'Пока нет серий.':'Срывов не зарегистрировано.')}`+
      (last?`\n\nСтраница ${page+1} из ${last+1}`:''),buttons(
      ...(!series?itemsOnPage.map(({row,index})=>[[`Открыть срыв №${index+1}`,`history:episode:${row.id}`]]):[]),
      ...(controls.length?[controls]:[]),[['Назад','history']]));
  };
  const episode=async(key,notice='')=>{
    const rows=await db.streaks(id);
    try {
      const target=historyTarget(rows,'edit',key),page=Math.floor((rows.length-2-target.index)/historyPageSize);
      return send((notice?esc(notice)+'\n\n':'')+episodeReport(target,user.timezone),buttons(
        [['Исправить','history:edit:'+key],['Удалить','history:remove:'+key]],[['Назад','history:lapses:'+page]]));
    }catch(e) {if(!(e instanceof ValidationError))throw e;return send(esc(e.message),buttons([['📅 История','history']]));}
  };
  const exitHistory=async()=>{
    const {kind,key}=data.change;
    await clear();return kind==='initial'?showHistory():episode(key);
  };
  const historyFields=async(next,notice='')=>{
    await save({...next,state:'Form:historyFields',field:undefined,input:undefined,relative_date:undefined,nonce:nonce()});
    const {begin,last,count}=data.change;
    return send((notice?esc(notice)+'\n\n':'')+'✏️ <b>Исправление срыва</b>\n\n'+episodeFields(begin,last,count,data.timezone),buttons(
      [pick('Первая сигарета','first')],[pick('Последняя сигарета','last')],[pick('Количество сигарет','count')],
      [pick('Проверить изменения','review')],nav()));
  };
  const reviewHistory=async next=>{
    const {change,timezone}=next,rows=await db.streaks(id);
    if(timezone!==user.timezone)throw new ValidationError('Часовой пояс изменился. Открой историю заново.');
    const {first,second,index}=historyTarget(rows,change.kind,change.key);
    validateHistoryChange(rows,change,now);
    await save({...next,state:'Form:historyReview',nonce:nonce()});
    if(change.kind==='remove')return send(episodeReport({first,second,index},timezone)+
      '\n\nУдалить эту запись? Соседние серии объединятся, и статистика будет пересчитана.',
      buttons([pick('Подтвердить удаление','commit')],nav()));
    const render=change.kind==='initial'
      ?`<b>Было</b>\n${dateLabel(first.start,timezone)}\n\n<b>Будет</b>\n${dateLabel(change.start,timezone)}`
      :`Срыв №${index+1}\n\n<b>Было</b>\n${episodeFields(first.end,second.start,first.lapse_count,timezone)}\n\n<b>Будет</b>\n${episodeFields(change.begin,change.last,change.count,timezone)}`;
    return send('✏️ <b>Проверь изменения</b>\n\n'+render,buttons([pick('Сохранить изменения','commit')],nav()));
  };
  const beginHistory=async(kind,key)=>{
    const rows=await db.streaks(id);
    try {
      const target=historyTarget(rows,kind,kind==='initial'?rows[0]?.id:key);
      const {first,second}=target;
      const next={mode:'history',timezone:user.timezone,change:{kind,key:first.id,snapshot:historySnapshot(target),
        ...(second?{begin:first.end,last:second.start,count:first.lapse_count}:{}),...(kind==='initial'?{start:first.start}:{})}};
      if(kind==='initial')return step({...next,field:'start',input:true});
      if(kind==='edit')return historyFields(next);
      return await reviewHistory(next);
    }catch(e) {if(!(e instanceof ValidationError))throw e;return kind==='initial'?send(esc(e.message),buttons([['📅 История','history']])):episode(key,e.message);}
  };
  const morning=async(fromNotifications=false)=>{
    const streaks=await db.streaks(id);
    const report=morningReport(calculate(streaks,now),now,user.timezone,id,streaks.at(-1)?.start);
    if(fromNotifications) {
      const keyboard=report.reply_markup.inline_keyboard;
      keyboard.flat().find(button=>button.callback_data.startsWith('health:fact:')).callback_data+=':n';
      keyboard.push([{text:'Назад',callback_data:'notifications'}]);
    }
    return send(report.text,report.reply_markup);
  };
  const healthSize=3;
  const stagesLink=[['📅 Все этапы восстановления','health:page:0']];
  const healthBack=[['Назад','report:health']];
  const health=async()=>{
    const seconds=(await stats()).current_seconds;
    return send(healthReport(seconds,compactDuration(seconds,true)),buttons(stagesLink,
      [['🔬 Подробнее и источники',`health:stage:${currentStage(seconds)}`]],[['Главное меню','home']]));
  };
  const healthPage=async page=>{
    const last=Math.ceil(stages.length/healthSize)-1;
    if(page>last)return health();
    const index=currentStage((await stats()).current_seconds),offset=page*healthSize;
    const items=stages.slice(offset,offset+healthSize);
    const summaries=items.map(([,label,text],i)=>`${offset+i<index?'✅ Пройдено':offset+i===index?'📍 Сейчас':'⏳ Впереди'} · <b>${label}</b>\n${text}`);
    return send(['📅 <b>Все этапы восстановления</b>',...summaries,`Страница ${page+1} из ${last+1}`,healthNote].join('\n\n'),buttons(
      ...items.map(([,label],i)=>[[label,`health:stage:${offset+i}`]]),
      [...(page?[['← Назад',`health:page:${page-1}`]]:[]),...(page<last?[['Далее →',`health:page:${page+1}`]]:[])],healthBack));
  };
  const healthStage=index=>{
    const stage=stages[index];
    if(!stage)return health();
    return send([`📅 <b>${stage[1]}</b>`,...stageCards(index),healthNote].join('\n\n'),buttons(
      ...stage[3].map(key=>[[`Источник · ${healthCards[key][0]}`,`health:source:${index}:${key}`]]),
      [['Назад',`health:page:${Math.floor(index/healthSize)}`]]));
  };
  const healthSource=(key,index,fromNotifications=false)=>{
    if(!Object.hasOwn(healthCards,key)||(index!==undefined&&!stages[index]?.[3].includes(key)))return health();
    const [label,text,url,note]=healthCards[key];
    return send([`🔬 <b>${label}</b>`,text,note,`<a href="${url}">Открыть источник</a>`].filter(Boolean).join('\n\n'),
      buttons([['Назад',index===undefined?(fromNotifications?'morning:notifications':'morning'):`health:stage:${index}`]]));
  };
  const settingsBack=[['Назад','settings']];
  const aboutBack=[['Назад','settings:about']];
  const homeLink=[['Главное меню','home']];
  const showSettings=async notice=>send([
    '<b>⚙️ Настройки</b>',notice,`📅 Последняя сигарета: ${dateLabel((await db.streaks(id)).at(-1).start,user.timezone)}`,
    habitSummary(user),notificationSummary(user)
  ].filter(Boolean).join('\n\n'),buttons([['📅 Дата и история','settings:history']],[['💰 Привычка и экономия','settings:habit']],
    [['🔔 Уведомления','notifications'],['🌍 Часовой пояс','edit:timezone']],[['ℹ️ О боте и мои данные','settings:about']],homeLink));
  const showHabit=notice=>send(['💰 <b>Привычка и экономия</b>',notice,habitSummary(user)].filter(Boolean).join('\n\n'),buttons(
    [['🚬 Привычка','edit:daily']],[['💰 Стоимость и валюта','edit:cost']],[['📦 Размер пачки','edit:pack']],
    [['⏳ Минут на сигарету','edit:minutes']],settingsBack));
  const showAbout=()=>send('ℹ️ <b>О боте и мои данные</b>\n\n«НЕ КУРЮ» помогает следить за прогрессом без сигарет и замечать положительные изменения. Бесплатно, без рекламы и осуждения.',buttons(
    [['🔐 Конфиденциальность','settings:privacy']],[['ℹ️ Как считаем','settings:method']],[['🔬 Источники','settings:sources']],
    [['🗑 Удалить мои данные','delete']],settingsBack));
  const leaveSettingsForm=async notice=>{
    const {mode,field,fromAbout}=data;
    await clear();
    if(mode==='notify')return notifications(notice);
    if(fromAbout)return showAbout();
    return habitFields.includes(field)?showHabit(notice):showSettings(notice);
  };
  const scheduled=async()=>user.enabled&&user.next_due_at!=null&&await db.active()
    ?`\n📅 Следующий отчёт: ${dateLabel(user.next_due_at,user.timezone).replace(' ', ', ')}`
    :user.enabled?'\nБлижайшее время отправки пока недоступно.':'';
  const notifications=async notice=>{
    await save({state:'Form:notifications',nonce:nonce()});
    return send(['🔔 <b>Уведомления</b>',notice,notificationSummary(user)+await scheduled()].filter(Boolean).join('\n\n'),
      buttons([pick('🕒 Изменить время','edit')],
        [user.enabled?pick('🔕 Отключить рассылку','off'):pick('🔔 Подключить отчёты','enable')],
        [['Открыть отчёт','morning:notifications']],settingsBack));
  };
  const prompt=(notice='')=>{
    const {field,input,relative_date,mode,date_final,draft}=data;
    const zone=data.timezone||draft?.timezone;
    const prefix=mode==='register'?`<b>Шаг ${date_final?4:registerSteps.indexOf(field)+1} из 4</b>\n\n`:'';
    let text=formPrompts[field]||A.PROMPTS[field],rows=[];
    if(field==='report_time') {
      const editing=data.intent==='edit'||mode==='edit';
      text=input?timeInput:`<b>🔔 ${editing?'Время ежедневного отчёта':'Ежедневный отчёт'}</b>\n\n${editing?'Выбери новое время. Состояние подписки сохранится.':'Во сколько тебе удобно получать отчёт о своём прогрессе?'}\n\n🌍 Часовой пояс: ${esc(zoneLabel(user.timezone))}\n\nВремя всегда можно изменить в настройках.`;
      if(!input)rows=[reportTimes.slice(0,3).map(value=>pick(value,'v'+value)),reportTimes.slice(3).map(value=>pick(value,'v'+value)),[pick('🕒 Указать своё время','manual')],...(!editing?[[pick('Не сейчас','later')]]:[])];
    }else if(['start','lapse_begin','lapse_last'].includes(field)) {
      const question=field==='start'?(mode==='history'?'Когда началось отслеживание?':'Когда была последняя сигарета?'):formPrompts[field];
      text=question+'\n'+(relative_date?timeInput:dateInput)+(zone&&(mode!=='register'||date_final)?`\nЧасовой пояс: ${esc(zoneLabel(zone))}.`:'');
      if(!input)rows=[[pick('Сейчас','vСейчас'),pick('Сегодня','today')],[pick('Вчера','yesterday')],[pick('Указать дату и время','manual')]];
    }else if(field==='timezone') {
      if(input)text='Введи название города (например, Берлин) или часовой пояс (например, Asia/Tokyo).';
      else rows=[...timezones.map((value,i)=>[pick(zoneChoice(value,now),'z'+i)]),[pick('Другой город','manual')]];
    }else {
      const labels=field==='daily'?['10','20','30']:field==='lapse_count'?['1','2','3']:A.CHOICES[field]||[];
      if(input&&field==='daily')text='Введи целое число от 1 до 200.';
      if(!input&&labels.length)rows=[labels.map(value=>pick(value,'v'+value)),[pick('Другое','manual')]];
      if(mode==='history'&&field==='lapse_count')rows.push([pick('Не указано','vНе указано')]);
    }
    return send((notice?esc(notice)+'\n\n':'')+prefix+text,buttons(...rows,nav()));
  };
  const step=async(next,notice)=>{
    await save({...next,state:'Form:value',nonce:nonce()});
    return prompt(notice);
  };
  const chooseTime=(intent,offer=false)=>step({mode:'notify',field:'report_time',intent,offer});
  const register=async draft=>{
    await db.register(id,m.chat.id,{...draft,enabled:0},now);
    user=await db.user(id);
    await send('🚭 <b>НЕ КУРЮ</b>',menu());
    await progress();
    return chooseTime('enable',true);
  };
  const deletePrompt=async(fromAbout=false)=>{
    await save({state:'Form:delete',nonce:nonce(),fromAbout});
    return send('Удалить все твои данные? Будут удалены настройки, серии, срывы, достижения и очередь отправок. Отчёты прекратятся, вернуть историю через бота нельзя. Сообщения в Telegram останутся. Резервные копии удаляются владельцем отдельно, история восстановления D1 хранится до 7 дней. Для защиты от старых событий останется необратимая метка ID с датой удаления.',
      buttons([['Да, удалить мои данные',`delete:confirm:${data.nonce}`]],nav()));
  };
  const lapseReview=async(last,count,began=data.began)=>{
    if(minute(last)<minute(began)) throw new ValidationError('Последняя сигарета должна быть не раньше первой.');
    await save({...data,began,last,count,nonce:nonce(),state:'Form:confirm',mode:'lapse'});
    return send(`Записать срыв?${count===null?'':`\n🚬 Сигарет: ${count}`}\nПервая: ${dateLabel(began,data.timezone)}\nПоследняя: ${dateLabel(last,data.timezone)}\n\nС последней сигареты начнётся новая серия.`,buttons([['Подтвердить срыв',`lapse:confirm:${data.nonce}`]],nav()));
  };
  const lapsePrompt=async()=>{
    const active=(await db.streaks(id)).at(-1);
    await save({state:'Form:lapse',mode:'lapse',timezone:user.timezone,streak_id:active.id,nonce:nonce()});
    return send('Один срыв — не конец отказа. Всё, чего удалось добиться раньше, остаётся частью твоего пути.',buttons(
      [['🚬 Одна сигарета сейчас',`lapse:now:${data.nonce}`]],
      [['Указать другое время или количество',`lapse:other:${data.nonce}`]],nav()));
  };
  const later=async()=>{
    const offer=data.offer;
    await clear();
    const notice='Уведомления пока выключены. Отчёт можно открыть вручную командой /morning.';
    return offer?send(notice,menu()):notifications(notice);
  };
  const back=async()=>{
    const {mode,field,input,date_final}=data;
    if(mode==='history') {
      if(data.change.kind==='remove'||data.state==='Form:historyFields')return exitHistory();
      if(data.change.kind==='initial')return data.state==='Form:historyReview'?step({...data,field:'start',input:true}):exitHistory();
      return historyFields(data);
    }
    if(input)return step({...data,input:undefined,relative_date:undefined});
    if(mode==='register') {
      if(date_final)return step({...data,field:'timezone',date_final:undefined});
      const previous=registerSteps[registerSteps.indexOf(field)-1];
      return previous?step({...data,field:previous}):welcome();
    }
    if(mode==='notify')return data.offer?later():leaveSettingsForm();
    if(mode==='lapse') {
      const previous={lapse_count:'lapse_begin',lapse_last:'lapse_count'}[field];
      if(data.state==='Form:confirm'&&field)return step({...data,input:undefined,relative_date:undefined});
      return previous?step({...data,field:previous}):lapsePrompt();
    }
    if(!user)return welcome();
    if(mode==='edit'||data.fromAbout)return leaveSettingsForm();
    await clear();return showSettings();
  };
  const accept=async text=>{
    const {mode,field,relative_date,date_final}=data,zone=data.timezone||DEFAULTS.timezone;
    const value=/^🚭 сейчас$/i.test(text)?'Сейчас':text;
    try {
      if((field==='start'&&text==='📅 Указать дату и время')||(field==='daily'&&text==='Другое'))return step({...data,input:true});
      if(field==='report_time'&&(mode==='notify'||mode==='edit')) {
        const clock=parseField(field,value,zone,now);
        const enabling=data.intent==='enable';
        user=await db.notifications(id,enabling||Boolean(user.enabled),now,clock);
        await clear();
        return send(`<b>✅ ${enabling?'Ежедневный отчёт подключён':'Время отчёта сохранено'}</b>\n\n🕒 ${user.enabled?'Каждый день в ':''}${clock}\n🌍 ${esc(zoneLabel(user.timezone))}${await scheduled()}${user.enabled?'':'\nУведомления выключены.'}`,
          buttons([['🔔 Уведомления','notifications']],progressLink));
      }
      const dateValue=timeZone=>relative_date?relativeDate(parseField('report_time',value,timeZone,now),timeZone,relative_date):value;
      if(mode==='history') {
        const change={...data.change};
        if(change.kind==='initial') {
          change.start=parseDate(dateValue(zone),zone,now);
          return await reviewHistory({...data,change});
        }
        if(field==='lapse_count')change.count=value==='Не указано'?null:numeric(value,1,10000,true);
        else change[field==='lapse_begin'?'begin':'last']=parseDate(dateValue(zone),zone,now);
        return historyFields({...data,change});
      }
      if(mode==='register') {
        const draft={...data.draft};
        if(field==='start') {
          if(date_final||/^(?:сейчас|только что)$/i.test(value)) {
            draft.start=parseDate(dateValue(draft.timezone),draft.timezone,now);
            delete draft.start_input;delete draft.start_relative;
          }else {
            if(relative_date)draft.start_relative=relative_date;
            else {parseDate(value,draft.timezone,now,true);delete draft.start_relative;}
            draft.start_input=relative_date?parseField('report_time',value,zone,now):value;
          }
          if(date_final)return register(draft);
        }else if(field==='cost')Object.assign(draft,parseField(field,value,zone,now));
        else if(field==='timezone') {
          draft.timezone=parseZone(value,now);
          if(draft.start_input) {
            try {
              const start=draft.start_relative?relativeDate(draft.start_input,draft.timezone,draft.start_relative):draft.start_input;
              draft.start=parseDate(start,draft.timezone,now);
            }catch(e) {
              if(!(e instanceof ValidationError))throw e;
              return step({...data,draft,field:'start',date_final:true,input:true,relative_date:undefined},e.message);
            }
            delete draft.start_input;delete draft.start_relative;
          }
          return register(draft);
        }else draft[field]=parseField(field,value,zone,now);
        const next=registerSteps[registerSteps.indexOf(field)+1];
        return step({...data,draft,field:next,input:undefined,relative_date:undefined});
      }
      if(mode==='edit') {
        const parsed=field==='timezone'?parseZone(value,now):parseField(field,dateValue(zone),zone,now);
        await db.change(id,field,parsed,now);
        if(field!=='start') {
          user={...user,...(field==='cost'?parsed:{[field]:parsed})};
          return leaveSettingsForm('✅ Сохранено.');
        }
        await clear();return send('Сохранено.',buttons(settingsBack));
      }
      if(mode==='lapse') {
        if(field==='lapse_begin') {
          const began=parseDate(dateValue(zone),zone,now),active=(await db.streaks(id)).at(-1);
          if(minute(began)<minute(active.start))throw new ValidationError('Первая сигарета не может быть раньше начала текущей серии.');
          return step({...data,began,field:'lapse_count',input:undefined,relative_date:undefined});
        }
        if(field==='lapse_count') {
          const count=numeric(value,1,10000,true);
          if(count===1)return await lapseReview(data.began,count);
          return step({...data,count,field:'lapse_last',input:undefined,relative_date:undefined});
        }
        const last=text==='Одна сигарета'?data.began:parseDate(dateValue(zone),zone,now);
        return await lapseReview(last,data.count??(text==='Одна сигарета'?1:null));
      }
    }catch(e) {if(!(e instanceof ValidationError))throw e;return prompt(e.message);}
  };

  if(cb) {
    try {await api(env,'answerCallbackQuery',{callback_query_id:cb.id});}catch{}
    const remove=async()=>{try {await api(env,'editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:{inline_keyboard:[]}});}catch{}};
    const action=cb.data;
    const matchesNonce=()=>action.split(':').at(-1)===data.nonce;
    if(action.startsWith('f:')) {
      const [,key,choice]=action.split(':',3);
      if(!data.nonce||key!==data.nonce)return send('Эта кнопка устарела. Используй последние кнопки или /start.');
      if(choice==='cancel') {await remove();return cancel();}
      if(choice==='back') {await remove();return back();}
      if(choice==='home') {await remove();return home();}
      if(data.state==='Form:welcome'&&!user&&choice==='begin') {
        await remove();return step({mode:'register',field:'start',draft:{...DEFAULTS}});
      }
      if(data.state==='Form:notifications'&&user) {
        if(choice==='off') {user=await db.notifications(id,false,now);await remove();return notifications();}
        if(choice==='enable'||choice==='edit') {await remove();return chooseTime(choice);}
      }
      if(data.mode==='history'&&data.state==='Form:historyFields') {
        if(choice==='review') {
          try {return await reviewHistory(data);}
          catch(e) {if(!(e instanceof ValidationError))throw e;return historyFields(data,e.message);}
        }
        const field={first:'lapse_begin',last:'lapse_last',count:'lapse_count'}[choice];
        if(field&&typeof field==='string'){await remove();return step({...data,field,input:field!=='lapse_count'});}
      }
      if(data.mode==='history'&&data.state==='Form:historyReview'&&choice==='commit') {
        const removal=data.change.kind==='remove';
        try {
          if(data.timezone!==user.timezone)throw new ValidationError('Часовой пояс изменился. Открой историю заново.');
          await db.changeHistory(id,data.change,now);
          await clear();await remove();
          return send(removal?'Запись удалена. Серии объединены, статистика обновлена.':'Изменения сохранены. Статистика обновлена.',buttons([['📅 История','history']],progressLink));
        }catch(e) {if(!(e instanceof ValidationError))throw e;await clear();return send(esc(e.message),buttons([['📅 История','history']]));}
      }
      if(data.state!=='Form:value')return;
      if(choice==='manual') {await remove();return step({...data,input:true});}
      if(choice==='today'||choice==='yesterday') {
        if(!['start','lapse_begin','lapse_last'].includes(data.field))return;
        await remove();return step({...data,input:true,relative_date:{at:now,days:choice==='today'?0:1}});
      }
      if(choice==='later'&&data.mode==='notify'&&data.intent==='enable') {await remove();return later();}
      const value=action.slice(`f:${key}:`.length);
      if(value.startsWith('v')) {await remove();return accept(value.slice(1));}
      if(data.field==='timezone'&&/^z\d$/.test(value)&&timezones[+value.slice(1)]) {await remove();return accept(timezones[+value.slice(1)]);}
      return;
    }
    if(action==='cancel'||action==='notify:off')return send('Эта кнопка устарела. Используй последние кнопки или /cancel.');
    if(action==='privacy')return send(PRIVACY,data.state==='Form:welcome'?buttons([pick('Назад','back')]):undefined);
    if(action.startsWith('delete:confirm:')) {
      if(data.state!=='Form:delete'||!matchesNonce())return send('Подтверждение устарело. Для удаления используй /delete.');
      await db.deleteAccount(id,botId,db.subject,now);
      return send('Данные удалены, утренние отчёты отключены. Сообщения в Telegram остаются. Резервные копии удаляются владельцем отдельно, история восстановления D1 — до 7 дней. Старые события не восстановят аккаунт. Начать заново можно командой /start.',{remove_keyboard:true});
    }
    if(action.startsWith('register:')) {
      if(user||data.state!=='Form:register'||!matchesNonce())return send('Эта кнопка устарела. Используй /start.');
      return step({mode:'register',draft:data.draft,field:'daily'});
    }
    if(!user) return send('Сначала /start.');
    if(action==='settings') {await clear();return showSettings();}
    if(action==='delete')return deletePrompt(true);
    if(action==='settings:history') {if(data.state)await clear();return showHistory('settings');}
    if(action==='settings:habit') {if(data.state)await clear();return showHabit();}
    if(action==='settings:about') {if(data.state)await clear();return showAbout();}
    if(action==='settings:privacy')return send(PRIVACY,buttons(aboutBack));
    if(action==='settings:method')return send(methodologyReport(true),buttons(aboutBack));
    if(action==='settings:sources')return send('🔬 <b>Источники о восстановлении</b>\n\n'+generalSources,buttons(stagesLink,aboutBack));
    if(action==='notifications')return notifications();
    if(action==='notify:on')return user.enabled?notifications():chooseTime('enable');
    if(action==='progress')return progress();
    if(action==='home')return home();
    if(action==='morning'||action==='morning:notifications')return morning(action==='morning:notifications');
    if(action==='progress:details')return detailedProgress();
    if(action==='history') {if(data.state)await clear();return showHistory();}
    if(action==='history:initial')return beginHistory('initial');
    const historyAction=/^history:(series|lapses|episode|edit|remove):(\d{1,16})$/.exec(action);
    if(historyAction) {
      const [,kind,key]=historyAction;
      if(!Number.isSafeInteger(+key))return;
      if(kind==='series'||kind==='lapses')return historyPage(kind,+key);
      if(kind==='episode')return episode(+key);
      return beginHistory(kind,+key);
    }
    if(action==='awards')return achievements();
    if(action==='report:health')return health();
    if(action==='health:all')return healthPage(0);
    const healthAction=/^health:(page|stage|source):(\d)(?::([a-z]+))?$/.exec(action);
    if(healthAction) {
      const [,kind,index,key]=healthAction;
      return kind==='page'?healthPage(+index):kind==='stage'?healthStage(+index):healthSource(key,+index);
    }
    const fact=/^health:fact:([a-z]+)(:n)?$/.exec(action);
    if(fact)return healthSource(fact[1],undefined,Boolean(fact[2]));
    if(action==='report:methodology')return send(methodologyReport(),buttons([['📖 Подробнее и источники','methodology:details']],progressLink));
    if(action==='methodology:details')return send(methodologyReport(true),buttons(methodLink,progressLink));
    if(action==='craving')return craving();
    if(action==='craving:passed') {await remove();return send('Ещё одна волна позади. Продолжай в своём темпе. 🚭',buttons(progressLink,[['Хочу закурить','craving']]));}
    const tip=/^craving:tip:([a-z]+):(\d{1,2})$/.exec(action);
    if(tip)return cravingTip(tip[1],+tip[2]);
    if(action.startsWith('edit:')) {
      const field=action.split(':')[1];
      if(!A.FIELDS.includes(field))return;
      if(field==='report_time')return chooseTime('edit');
      return step({mode:'edit',field,timezone:user.timezone});
    }
    if(action==='lapse')return lapsePrompt();
    if(action.startsWith('lapse:now:')||action.startsWith('lapse:other:')) {
      // Older messages offered a custom time from the confirmation screen.
      const legacy=data.state==='Form:confirm'&&data.count==null&&action.startsWith('lapse:other:');
      if(data.mode!=='lapse'||!matchesNonce()||(data.state!=='Form:lapse'&&!legacy))return send('Эта кнопка устарела. Открой отметку срыва заново.');
      if(action.startsWith('lapse:now:')) {
        const began=stamp(minute(now));
        return lapseReview(began,1,began);
      }
      await remove();return step({...data,field:'lapse_begin'});
    }
    if(action.startsWith('lapse:confirm:')) {
      if(data.state!=='Form:confirm'||data.mode!=='lapse'||!matchesNonce())return send('Эта отметка уже обработана или отменена.');
      try {
        await db.lapse(id,data.streak_id,data.began,data.last,now,data.count??(data.began===data.last?1:null));
        await send('☀️ <b>Твой путь продолжается</b>\n\nОдин срыв не перечёркивает предыдущие успехи. Накопленный прогресс и заслуженные достижения сохраняются.',menu());
      } catch(e) {if(!(e instanceof ValidationError))throw e;await send(esc(e.message),menu());}
      await clear();await remove();return;
    }
    return;
  }

  const text=m.text?.trim();
  if(/^\/privacy(?:@\w+)?$/.test(text))return send(PRIVACY);
  if(/^\/delete(?:@\w+)?$/.test(text))return deletePrompt();
  if(/^\/start(?:@\w+)?(?:\s|$)/.test(text)) {
    if(user)return home();
    if(data.mode==='register'&&data.draft) {
      const field=registerSteps.includes(data.field)?data.field:'daily';
      return step({...data,field});
    }
    return welcome();
  }
  if(text==='Отмена'||/^\/cancel(?:@\w+)?(?:\s|$)/.test(text))return cancel();
  if(text==='Назад'&&data.state)return back();
  if(/^\/morning(?:@\w+)?$/.test(text)) {
    if(!user) return send('Сначала /start.');
    return morning();
  }
  if(text===RECOVERY_LABEL||A.MENU_LABELS.includes(text)) {
    if(!user)return send('Сначала /start.');
    if(data.state)await clear();
    if(text===A.MENU_LABELS[0])return progress();
    if(text===RECOVERY_LABEL||text===A.MENU_LABELS[1])return health();
    if(text===A.MENU_LABELS[2])return achievements();
    if(text===A.MENU_LABELS[3])return craving();
    return showSettings();
  }

  if(data.state==='Form:value') {
    if(!data.nonce)await save({...data,nonce:nonce()});
    return text?accept(text):prompt('Нужен текст или кнопка с ответом.');
  }
  if(data.state==='Form:confirm'||data.state==='Form:lapse'||data.state==='Form:delete')return send('Выбери действие кнопкой или напиши /cancel.');
  if(data.mode==='history')return send('Выбери действие кнопкой или напиши /cancel.');
  if(data.state==='Form:register')return send('Продолжить регистрацию: /start.');
  if(data.state==='Form:welcome'&&!user)return welcome();
  return send('Выбери раздел меню или начни с /start.',user?menu():undefined);
}
