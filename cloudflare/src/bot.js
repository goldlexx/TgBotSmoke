import {
  A,esc,minute,stamp,local,parseDate,parseField,numeric,calculate,morningReport,reportButtons,
  healthReport,methodologyReport,progressReport,awardsReport,cravingReport,menu,buttons,
  settings,dateLabel,zoneLabel,cities,currencySymbol,DEFAULTS,PRIVACY,ValidationError
} from './core.js';
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
const settingsSummary=(user,active)=>[
  `🚭 Последняя сигарета: ${dateLabel(active.start,user.timezone)}`,
  `🚬 ${user.daily} сигарет/день · ${esc(user.price)} ${esc(currencySymbol(user.currency))}/пачка (${user.pack} шт.)`,
  `⏰ Отчёт: ${user.enabled?user.report_time:'выключен'} · ${esc(zoneLabel(user.timezone))}`
].join('\n');

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
    await clear();return send('Ввод отменён.',menu());
  };
  const stats=async()=>calculate(await db.streaks(id),now);
  const earned=async()=>new Set((await db.awards(id,now)).map(a=>a.days));
  const progress=async()=>send(progressReport(await stats(),await earned()),buttons([['🏆 Все достижения','awards']]));
  const home=async()=>{
    if(!user)return welcome();
    await clear();await send('🚭 <b>НЕ КУРЮ</b>',menu());return progress();
  };
  const achievements=async()=>send(awardsReport((await stats()).current_seconds,await earned()),buttons([['📊 Мой прогресс','progress']]));
  const health=async(all=false)=>send(healthReport((await stats()).current_seconds,all),all
    ?buttons([['🫁 Здоровье','report:health']])
    :buttons([['✅ Все достигнутые изменения','health:all']]));
  const showSettings=async()=>send('<b>⚙️ Настройки</b>\n\n'+settingsSummary(user,(await db.streaks(id)).at(-1)),settings());
  const scheduled=async()=>user.enabled&&user.next_due_at!=null&&await db.active()
    ?`\n📅 Следующий отчёт: ${dateLabel(user.next_due_at,user.timezone).replace(' ', ', ')}`
    :user.enabled?'\nБлижайшее время отправки пока недоступно.':'';
  const notifications=async()=>{
    await save({state:'Form:notifications',nonce:nonce()});
    return send(`<b>⏰ Уведомления</b>\n\nЕжедневный отчёт ${user.enabled?'включён':'выключен'}.\nВремя: ${user.report_time} · ${esc(zoneLabel(user.timezone))}${await scheduled()}`,
      buttons([pick('🕒 Изменить время','edit')],
        [user.enabled?pick('🔕 Отключить рассылку','off'):pick('🔔 Подключить отчёты','enable')],[['⚙️ Настройки','settings']]));
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
      const question=field==='start'?'Когда была последняя сигарета?':formPrompts[field];
      text=question+'\n'+(relative_date?timeInput:dateInput)+(zone&&(mode!=='register'||date_final)?`\nЧасовой пояс: ${esc(zoneLabel(zone))}.`:'');
      if(!input)rows=[[pick('Сейчас','vСейчас'),pick('Сегодня','today')],[pick('Вчера','yesterday')],[pick('Указать дату и время','manual')]];
    }else if(field==='timezone') {
      if(input)text='Введи название города (например, Берлин) или часовой пояс (например, Asia/Tokyo).';
      else rows=[...timezones.map((value,i)=>[pick(zoneChoice(value,now),'z'+i)]),[pick('Другой город','manual')]];
    }else {
      const labels=field==='daily'?['10','20','30']:field==='lapse_count'?['1','2','3']:A.CHOICES[field]||[];
      if(input&&field==='daily')text='Введи целое число от 1 до 200.';
      if(!input&&labels.length)rows=[labels.map(value=>pick(value,'v'+value)),[pick('Другое','manual')]];
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
  const deletePrompt=async()=>{
    await save({state:'Form:delete',nonce:nonce()});
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
    await clear();
    return send('Уведомления пока выключены. Подключить их можно в настройках, а открыть отчёт вручную — командой /morning.',menu());
  };
  const back=async()=>{
    const {mode,field,input,date_final}=data;
    if(input)return step({...data,input:undefined,relative_date:undefined});
    if(mode==='register') {
      if(date_final)return step({...data,field:'timezone',date_final:undefined});
      const previous=registerSteps[registerSteps.indexOf(field)-1];
      return previous?step({...data,field:previous}):welcome();
    }
    if(mode==='notify')return data.offer?later():notifications();
    if(mode==='lapse') {
      const previous={lapse_count:'lapse_begin',lapse_last:'lapse_count'}[field];
      if(data.state==='Form:confirm'&&field)return step({...data,input:undefined,relative_date:undefined});
      return previous?step({...data,field:previous}):lapsePrompt();
    }
    if(!user)return welcome();
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
        return send(`<b>✅ ${enabling?'Ежедневный отчёт подключён':'Время отчёта сохранено'}</b>\n\n🕒 ${user.enabled?'Каждый день в ':''}${clock}\n🌍 ${esc(zoneLabel(user.timezone))}${await scheduled()}${user.enabled?'':'\nУведомления выключены.'}`,menu());
      }
      const dateValue=timeZone=>relative_date?relativeDate(parseField('report_time',value,timeZone,now),timeZone,relative_date):value;
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
        await clear();return send('Сохранено.',menu());
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
    if(action==='delete')return deletePrompt();
    if(action==='notifications')return notifications();
    if(action==='notify:on')return user.enabled?notifications():chooseTime('enable');
    if(action==='progress')return progress();
    if(action==='awards')return achievements();
    if(action==='report:health'||action==='health:all')return health(action==='health:all');
    if(action==='report:methodology')return send(methodologyReport(),buttons([['📖 Подробнее и источники','methodology:details']]));
    if(action==='methodology:details')return send(methodologyReport(true),buttons([['ℹ️ Как считаем','report:methodology']]));
    if(action==='craving:passed') {await remove();return send('Ещё одна волна позади. Серия продолжается! 🚭');}
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
        await send('Новая серия началась. Прежние результаты и награды сохранены. 🚭',menu());
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
    return send(morningReport(await stats(),local(now,user.timezone).day,id),reportButtons());
  }
  if(A.MENU_LABELS.includes(text)) {
    if(!user)return send('Сначала /start.');
    if(data.state)await clear();
    if(text===A.MENU_LABELS[0])return progress();
    if(text===A.MENU_LABELS[1])return health();
    if(text===A.MENU_LABELS[2])return achievements();
    if(text===A.MENU_LABELS[3])return send(cravingReport(await stats()),buttons(
      [['✅ Отпустило','craving:passed'],['🚬 Был срыв','lapse']]
    ));
    return showSettings();
  }

  if(data.state==='Form:value') {
    if(!data.nonce)await save({...data,nonce:nonce()});
    return text?accept(text):prompt('Нужен текст или кнопка с ответом.');
  }
  if(data.state==='Form:confirm'||data.state==='Form:lapse'||data.state==='Form:delete')return send('Выбери действие кнопкой или напиши /cancel.');
  if(data.state==='Form:register')return send('Продолжить регистрацию: /start.');
  if(data.state==='Form:welcome'&&!user)return welcome();
  return send('Выбери раздел меню или начни с /start.',user?menu():undefined);
}
