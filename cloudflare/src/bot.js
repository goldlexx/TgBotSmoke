import {
  A,esc,minute,stamp,local,parseDate,parseField,numeric,calculate,morningReport,reportButtons,
  healthReport,methodologyReport,progressReport,awardsReport,cravingReport,menu,choices,buttons,
  settings,confirmation,dateLabel,zoneLabel,currencySymbol,DEFAULTS,PRIVACY,ValidationError
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

const startChoices=['🚭 Сейчас','📅 Указать дату и время'];
const registerSteps=['start','daily','cost','timezone'];
const formPrompts={
  daily:'Сколько сигарет в день было обычно?',
  cost:'Сколько стоила пачка? Например, 250 ₽ или 5,50 EUR. Если указать только сумму, считаем в ₽.',
  timezone:'В каком часовом поясе присылать отчёт? Выбери ближайший или введи свой, например Europe/Berlin.',
  lapse_begin:'Когда была первая сигарета после отказа? Введи дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ.',
  lapse_count:'Сколько сигарет было выкурено?',
  lapse_last:'Когда была последняя сигарета? С этого момента начнётся новая серия.'
};
const dateInput='Введи дату и время в формате ДД.ММ.ГГГГ ЧЧ:ММ.';
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
  const stats=async()=>calculate(await db.streaks(id),now);
  const earned=async()=>new Set((await db.awards(id,now)).map(a=>a.days));
  const progress=async()=>send(progressReport(await stats(),await earned()),buttons([['🏆 Все достижения','awards']]));
  const achievements=async()=>send(awardsReport((await stats()).current_seconds,await earned()),buttons([['📊 Мой прогресс','progress']]));
  const health=async(all=false)=>send(healthReport((await stats()).current_seconds,all),all
    ?buttons([['🫁 Здоровье','report:health']])
    :buttons([['✅ Все достигнутые изменения','health:all']]));
  const showSettings=async()=>send('<b>⚙️ Настройки</b>\n\n'+settingsSummary(user,(await db.streaks(id)).at(-1)),settings());
  const notifications=()=>send(
    `<b>⏰ Уведомления</b>\n\nУтренний отчёт ${user.enabled?'включён':'выключен'}.\nВремя: ${user.report_time} · ${esc(zoneLabel(user.timezone))}`,
    buttons([['🕒 Изменить время','edit:report_time']],[user.enabled?['🔕 Отключить рассылку','notify:off']:['🔔 Включить рассылку','notify:on']],[['⚙️ Настройки','settings']])
  );
  const prompt=field=>{
    if(field==='start') {
      const question=data.mode==='register'&&!data.date_final?'Когда была последняя сигарета?'
        :`${dateInput} Часовой пояс: ${esc(zoneLabel(data.timezone||data.draft.timezone))}.`;
      return send(question,choices(...startChoices));
    }
    const labels=field==='daily'?['10','20','30','Другое']:field==='lapse_count'?['1','2','3']:
      field==='lapse_begin'||field==='lapse_last'?['Сейчас']:A.CHOICES[field];
    const text=field==='lapse_last'?formPrompts[field]+' '+dateInput:formPrompts[field]||A.PROMPTS[field];
    return send(text,choices(...labels));
  };
  const register=async draft=>{
    await db.register(id,m.chat.id,draft,now);
    user=await db.user(id);
    await clear();
    return send('<b>🚀 Всё готово!</b>\n\n'+settingsSummary(user,draft)+
      `\n⏳ ${user.minutes} мин. на сигарету`,menu());
  };
  const deletePrompt=async()=>{
    const nonce=crypto.randomUUID().replaceAll('-','');
    await save({state:'Form:delete',nonce});
    return send('Удалить все твои данные? Будут удалены настройки, серии, срывы, достижения и очередь отправок. Отчёты прекратятся, вернуть историю через бота нельзя. Сообщения в Telegram останутся. Резервные копии удаляются владельцем отдельно, история восстановления D1 хранится до 7 дней. Для защиты от старых событий останется необратимая метка ID с датой удаления.',
      buttons([['Да, удалить мои данные',`delete:confirm:${nonce}`]], [['Отмена','cancel']]));
  };
  const lapseReview=async(last,count,began=data.began)=>{
    if(minute(last)<minute(began)) throw new ValidationError('Последняя сигарета должна быть не раньше первой.');
    const nonce=crypto.randomUUID().replaceAll('-','');
    await save({...data,began,last,count,nonce,state:'Form:confirm',mode:'lapse'});
    return send(`Записать срыв?${count===null?'':`\n🚬 Сигарет: ${count}`}\nПервая: ${dateLabel(began,data.timezone)}\nПоследняя: ${dateLabel(last,data.timezone)}\n\nС последней сигареты начнётся новая серия.`,confirmation(nonce));
  };

  if(cb) {
    try {await api(env,'answerCallbackQuery',{callback_query_id:cb.id});}catch{}
    const remove=async()=>{try {await api(env,'editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:{inline_keyboard:[]}});}catch{}};
    const action=cb.data;
    const matchesNonce=()=>action.split(':').at(-1)===data.nonce;
    if(action==='cancel') {await clear();await remove();return send(user?'Отменено.':'Отменено. Начать заново: /start',user?menu():{remove_keyboard:true});}
    if(action==='privacy')return send(PRIVACY);
    if(action.startsWith('delete:confirm:')) {
      if(data.state!=='Form:delete'||!matchesNonce())return send('Подтверждение устарело. Для удаления используй /delete.');
      await db.deleteAccount(id,botId,db.subject,now);
      return send('Данные удалены, утренние отчёты отключены. Сообщения в Telegram остаются. Резервные копии удаляются владельцем отдельно, история восстановления D1 — до 7 дней. Старые события не восстановят аккаунт. Начать заново можно командой /start.',{remove_keyboard:true});
    }
    if(action.startsWith('register:')) {
      if(user||data.state!=='Form:register'||!matchesNonce())return send('Эта кнопка устарела. Используй /start.');
      await save({state:'Form:value',mode:'register',draft:data.draft,field:'daily'});
      return prompt('daily');
    }
    if(!user) return send('Сначала /start.');
    if(action==='settings') {await clear();return showSettings();}
    if(action==='delete')return deletePrompt();
    if(action==='notifications') {await clear();return notifications();}
    if(action==='notify:on'||action==='notify:off') {
      const enabled=action==='notify:on';
      if(Boolean(user.enabled)!==enabled)await db.notifications(id,enabled,now);
      user={...user,enabled};await clear();return notifications();
    }
    if(action==='progress')return progress();
    if(action==='awards')return achievements();
    if(action==='report:health'||action==='health:all')return health(action==='health:all');
    if(action==='report:methodology')return send(methodologyReport(),buttons([['📖 Подробнее и источники','methodology:details']]));
    if(action==='methodology:details')return send(methodologyReport(true),buttons([['ℹ️ Как считаем','report:methodology']]));
    if(action==='craving:passed') {await remove();return send('Ещё одна волна позади. Серия продолжается! 🚭');}
    if(action.startsWith('edit:')) {
      const field=action.split(':')[1];
      if(!A.FIELDS.includes(field))return;
      await save({state:'Form:value',mode:'edit',field,timezone:user.timezone});
      return prompt(field);
    }
    if(action==='lapse') {
      const active=(await db.streaks(id)).at(-1),nonce=crypto.randomUUID().replaceAll('-','');
      await save({state:'Form:lapse',mode:'lapse',timezone:user.timezone,streak_id:active.id,nonce});
      return send('Один срыв — не конец отказа. Всё, чего удалось добиться раньше, остаётся частью твоего пути.',buttons(
        [['🚬 Одна сигарета сейчас',`lapse:now:${nonce}`]],
        [['Указать другое время или количество',`lapse:other:${nonce}`]],
        [['Отмена','cancel']]
      ));
    }
    if(action.startsWith('lapse:now:')||action.startsWith('lapse:other:')) {
      // Older messages offered a custom time from the confirmation screen.
      const legacy=data.state==='Form:confirm'&&data.count==null&&action.startsWith('lapse:other:');
      if(data.mode!=='lapse'||!matchesNonce()||(data.state!=='Form:lapse'&&!legacy))return send('Эта кнопка устарела. Открой отметку срыва заново.');
      if(action.startsWith('lapse:now:')) {
        const began=stamp(minute(now));
        return lapseReview(began,1,began);
      }
      await save({...data,state:'Form:value',field:'lapse_begin'});
      return prompt('lapse_begin');
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
    if(user) {await clear();await send('🚭 <b>НЕ КУРЮ</b>',menu());return progress();}
    if(data.mode==='register'&&data.draft) {
      const field=registerSteps.includes(data.field)?data.field:'daily';
      await save({...data,state:'Form:value',field});
      return prompt(field);
    }
    await save({state:'Form:value',mode:'register',field:'start',draft:{...DEFAULTS}});
    await send('🚀 <b>Начнём</b>\nТри вопроса и часовой пояс. О данных: /privacy.');
    return prompt('start');
  }
  if(text==='Отмена'||/^\/cancel(?:@\w+)?(?:\s|$)/.test(text)) {
    await clear();return send(user?'Ввод отменён.':'Ввод отменён. Начать заново: /start',user?menu():{remove_keyboard:true});
  }
  if(/^\/morning(?:@\w+)?$/.test(text)) {
    if(!user) return send('Сначала /start.');
    return send(morningReport(await stats(),local(now,user.timezone).day,id),reportButtons());
  }
  if(A.MENU_LABELS.includes(text)) {
    if(!user)return send('Сначала /start.');
    if(data.state) {await clear();await send('Выбери раздел меню.',menu());}
    if(text===A.MENU_LABELS[0])return progress();
    if(text===A.MENU_LABELS[1])return health();
    if(text===A.MENU_LABELS[2])return achievements();
    if(text===A.MENU_LABELS[3])return send(cravingReport(await stats()),buttons(
      [['✅ Отпустило','craving:passed'],['🚬 Был срыв','lapse']]
    ));
    return showSettings();
  }

  if(data.state==='Form:value') {
    if(!text) return send('Нужен текст или кнопка с ответом.');
    const {mode,field}=data,zone=data.timezone||DEFAULTS.timezone;
    try {
      if(field==='start'&&text===startChoices[1])return send(dateInput);
      const value=text===startChoices[0]?'Сейчас':text;
      if(field==='daily'&&text==='Другое')return send('Введи целое число от 1 до 200.');
      if(mode==='register') {
        const draft={...data.draft};
        if(field==='start') {
          if(data.date_final||/^(?:сейчас|только что)$/i.test(value)) {
            draft.start=parseDate(value,draft.timezone,now);
            delete draft.start_input;
          } else {
            parseDate(value,draft.timezone,now,true);
            draft.start_input=value;
          }
          if(data.date_final)return register(draft);
        } else if(field==='cost')Object.assign(draft,parseField(field,value,zone,now));
        else if(registerSteps.includes(field))draft[field]=parseField(field,value,zone,now);
        if(field==='timezone') {
          if(draft.start_input) {
            try {draft.start=parseDate(draft.start_input,draft.timezone,now);delete draft.start_input;}
            catch(e) {
              if(!(e instanceof ValidationError))throw e;
              await save({...data,draft,field:'start',date_final:true});
              await send(esc(e.message));
              return prompt('start');
            }
          }
          return register(draft);
        }
        const next=registerSteps[registerSteps.indexOf(field)+1];
        await save({...data,draft,field:next});
        return prompt(next);
      }
      if(mode==='edit') {
        await db.change(id,field,parseField(field,value,zone,now),now);
        await clear();return send('Сохранено.',menu());
      }
      if(mode==='lapse') {
        if(field==='lapse_begin') {
          const began=parseDate(value,zone,now),active=(await db.streaks(id)).at(-1);
          if(minute(began)<minute(active.start))throw new ValidationError('Первая сигарета не может быть раньше начала текущей серии.');
          await save({...data,began,field:'lapse_count'});return prompt('lapse_count');
        }
        if(field==='lapse_count') {
          const count=numeric(value,1,10000,true);
          if(count===1)return await lapseReview(data.began,count);
          await save({...data,count,field:'lapse_last'});return prompt('lapse_last');
        }
        const last=text==='Одна сигарета'?data.began:parseDate(value,zone,now);
        return await lapseReview(last,data.count??(text==='Одна сигарета'?1:null));
      }
    } catch(e) {if(!(e instanceof ValidationError))throw e;return send(esc(e.message));}
  }
  if(data.state==='Form:confirm'||data.state==='Form:lapse'||data.state==='Form:delete')return send('Выбери действие кнопкой или напиши /cancel.');
  if(data.state==='Form:register')return send('Продолжить регистрацию: /start.');
  return send('Выбери раздел меню или начни с /start.',user?menu():undefined);
}
