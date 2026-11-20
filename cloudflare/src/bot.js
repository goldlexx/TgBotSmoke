import {A,esc,minute,local,stamp,parseDate,parseField,calculate,report,reportButtons,healthReport,methodologyReport,menu,choices,settings,confirmation,original,milestones,DEFAULTS,PRIVACY,ValidationError} from './core.js';
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
export async function handleUpdate(update,db,env,now=Date.now(),api=telegram) {
  const cb=update.callback_query,m=cb?.message||update.message;
  if(!m||m.chat.type!=='private') return;
  const id=(cb?.from||m.from).id,botId=Number(env.BOT_TOKEN.split(':')[0]);
  let data=await db.state(id,botId),user=await db.user(id);
  const send=(text,reply_markup)=>api(env,'sendMessage',{chat_id:m.chat.id,text,reply_markup,parse_mode:'HTML',link_preview_options:{is_disabled:true}});
  const prompt=field=>send(A.PROMPTS[field],choices(field));
  const save=async next=>{data=next;await db.saveState(id,botId,next);};
  const clear=()=>save({});
  const progress=async()=> {
    if(!user) return send('Для начала ответьте на вопросы: /start');
    const streaks=await db.streaks(id);
    await db.batch(db.awardStatements(id,streaks,now));
    return send(report(streaks,now,local(now,user.timezone).day,id),menu());
  };
  if(cb) {
    try {await api(env,'answerCallbackQuery',{callback_query_id:cb.id});}catch{}
    const remove=async()=>{try {await api(env,'editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:{inline_keyboard:[]}});}catch{}};
    if(cb.data==='cancel') {await clear();await remove();return send('Отменено.',menu());}
    if(cb.data==='privacy')return send(PRIVACY);
    if(cb.data.startsWith('delete:confirm:')) {
      if(data.state!=='Form:delete'||cb.data.split(':').at(-1)!==data.nonce)return send('Подтверждение устарело. Для удаления используйте /delete.');
      await db.deleteAccount(id,botId,db.subject,now);
      return send('Данные удалены, утренние отчёты отключены. Сообщения в Telegram остаются; резервные копии удаляются владельцем отдельно, история восстановления D1 — до 7 дней. Старые события не восстановят аккаунт. Начать заново можно только новой командой /start.',{remove_keyboard:true});
    }
    if(cb.data.startsWith('register:')) {
      if(user||data.state!=='Form:register'||cb.data.split(':').at(-1)!==data.nonce)return send('Эта регистрация уже обработана. Используйте /start.');
      if(cb.data.startsWith('register:custom:')) {
        await save({...data,state:'Form:value',mode:'register',field:'daily',remaining:A.FIELDS.slice(2)});
        return prompt('daily');
      }
      if(!cb.data.startsWith('register:confirm:'))return;
      const draft={...data.draft};
      try {if(draft.start_input){draft.start=parseDate(draft.start_input,draft.timezone,now);delete draft.start_input;}}
      catch(e){if(!(e instanceof ValidationError))throw e;return send(esc(e.message)+' Выберите точную настройку, чтобы указать часовой пояс.');}
      await db.register(id,m.chat.id,draft,now);user=await db.user(id);await clear();
      await send('Готово! Все значения можно изменить в настройках.',menu());return progress();
    }
    if(!user) return send('Сначала /start.');
    if(['notify:on','notify:off'].includes(cb.data)) {
      await db.notifications(id,cb.data==='notify:on',now);
      return send(cb.data==='notify:on'?'Утренние отчёты включены. Следующая отправка — в выбранное время, начиная со следующего подходящего дня.':'Утренние отчёты выключены. Прогресс остаётся доступен в меню.',settings(cb.data==='notify:on'));
    }
    if(cb.data==='report:health') return send(healthReport(calculate(await db.streaks(id),now).current_seconds));
    if(cb.data==='report:methodology') return send(methodologyReport());
    if(cb.data.startsWith('edit:')) {
      const field=cb.data.split(':')[1];if(!A.FIELDS.includes(field))return;
      await save({state:'Form:value',mode:'edit',field,timezone:user.timezone});await prompt(field);
      if(field==='start') await send(`Время вводите в поясе ${esc(user.timezone)}. Исправление даты пересчитает текущую серию.`);
      return;
    }
    if(cb.data==='lapse') {
      const active=(await db.streaks(id)).at(-1);
      const nonce=crypto.randomUUID().replaceAll('-','');
      await save({state:'Form:confirm',mode:'lapse',timezone:user.timezone,streak_id:active.id,began:stamp(minute(now)),last:stamp(minute(now)),nonce});
      const markup=confirmation(nonce);markup.inline_keyboard.push([{text:'Указать другое время / несколько сигарет',callback_data:`lapse:other:${nonce}`}]);
      return send('Одна сигарета сейчас? После подтверждения начнётся новая серия. Прежние результаты сохранятся. Можно продолжить без самокритики.',markup);
    }
    if(cb.data.startsWith('lapse:other:')) {
      if(data.state!=='Form:confirm'||data.mode!=='lapse'||cb.data.split(':').at(-1)!==data.nonce)return send('Эта отметка уже обработана или отменена.');
      await save({...data,state:'Form:value',field:'lapse_begin'});return prompt('lapse_begin');
    }
    if(cb.data.startsWith('lapse:confirm:')) {
      if(data.state!=='Form:confirm'||data.mode!=='lapse'||cb.data.split(':').at(-1)!==data.nonce) return send('Эта отметка уже обработана или отменена.');
      try {await db.lapse(id,data.streak_id,data.began,data.last,now);await send(original('Новая серия началась'),menu());}
      catch(e){if(!(e instanceof ValidationError))throw e;await send(esc(e.message),menu());}
      await clear();await remove();return;
    }
    return;
  }
  const text=m.text?.trim();
  if(text&&/^\/privacy(?:@\w+)?$/.test(text))return send(PRIVACY);
  if(text&&/^\/delete(?:@\w+)?$/.test(text)) {
    const nonce=crypto.randomUUID().replaceAll('-','');await save({state:'Form:delete',nonce});
    return send('Удалить все ваши данные? Будут удалены настройки, серии, срывы, достижения и очередь отправок. Отчёты прекратятся; вернуть историю через бота нельзя. Сообщения в Telegram останутся. Резервные копии удаляются владельцем отдельно, история восстановления D1 хранится до 7 дней. Для защиты от старых событий останется необратимая метка ID с датой удаления.',{inline_keyboard:[[{text:'Да, удалить мои данные',callback_data:`delete:confirm:${nonce}`}],[{text:'Отмена',callback_data:'cancel'}]]});
  }
  if(text && /^\/start(?:@\w+)?(?:\s|$)/.test(text)) {
    if(user) {await clear();return send(original('🚭 <b>НЕ КУРЮ</b>\nВаш прогресс'),menu());}
    if(data.state==='Form:value'&&data.mode==='register') {await send(original('Продолжим регистрацию'));return prompt(data.field);}
    await save({state:'Form:value',mode:'register',field:'start',remaining:[],draft:{...DEFAULTS}});
    await send('🚭 Начнём с даты последней сигареты. По умолчанию: 20 сиг./день, пачка 250 RUB / 20 сиг., 5 мин. на сигарету, Europe/Moscow, утренний отчёт 08:00. Перед сохранением можно выбрать точную настройку.\n\n'+PRIVACY);return prompt('start');
  }
  if(text==='Отмена'||(text&&/^\/cancel(?:@\w+)?(?:\s|$)/.test(text))) {
    await clear();return send(user?'Ввод отменён.':'Ввод отменён. Начать регистрацию: /start',user?menu():{remove_keyboard:true});
  }
  if(text&&/^\/morning(?:@\w+)?$/.test(text)) {
    if(!user) return send('Сначала /start.');
    return send(report(await db.streaks(id),now,local(now,user.timezone).day,id,true),reportButtons());
  }
  if(data.state==='Form:value') {
    if(!text) return send('Нужен текст или кнопка с ответом.');
    const {mode,field}=data,zone=data.timezone||'Europe/Moscow';
    try {
      if(mode==='register') {
        const draft=data.draft;
        if(field==='start'&&!data.date_final) {
          if(['сейчас','только что'].includes(text.toLowerCase())) {draft.start=stamp(minute(now));delete draft.start_input;}
          else {parseDate(text,zone,now,true);draft.start_input=text;}
        } else if(field==='start') {draft.start=parseDate(text,draft.timezone,now);delete draft.start_input;}
        else {const p=parseField(field,text,zone,now);if(field==='cost')Object.assign(draft,p);else draft[field]=p;}
        if(field==='timezone'&&draft.start_input) {
          try {draft.start=parseDate(draft.start_input,draft.timezone,now);delete draft.start_input;}
          catch(e) {await save({...data,draft,field:'start',date_final:true});await send(`Пояс сохранён. Уточните дату: ${esc(e.message)}`);return prompt('start');}
        }
        if(data.remaining.length) {
          const [next,...remaining]=data.remaining;await save({...data,draft,field:next,remaining});return prompt(next);
        }
        const nonce=crypto.randomUUID().replaceAll('-','');
        await save({state:'Form:register',mode:'register',draft,nonce});
        return send(`Проверьте параметры: ${draft.daily} сиг./день; пачка ${draft.price} ${draft.currency}, ${draft.pack} сиг.; ${draft.minutes} мин./сиг.; ${esc(draft.timezone)}; отчёт ${draft.report_time}.\nПоследняя сигарета: ${esc(draft.start_input||local(draft.start,draft.timezone).day+' '+local(draft.start,draft.timezone).clock)}.\nЗначения по умолчанию можно изменить сейчас или позже в настройках.`,{inline_keyboard:[[{text:'Сохранить эти параметры',callback_data:`register:confirm:${nonce}`}],[{text:'Точная настройка всех параметров',callback_data:`register:custom:${nonce}`}],[{text:'Отмена',callback_data:'cancel'}]]});
      }
      if(mode==='edit') {
        await db.change(id,field,parseField(field,text,zone,now),now);await clear();return send(original('Сохранено. Параметры'),menu());
      }
      if(mode==='lapse') {
        if(field==='lapse_begin') {
          const began=parseDate(text,zone,now),active=(await db.streaks(id)).at(-1);
          if(minute(began)<minute(active.start)) throw new ValidationError('Начало срыва не может быть раньше начала текущей серии.');
          await save({...data,began,field:'lapse_last'});return prompt('lapse_last');
        }
        const last=text==='Одна сигарета'?data.began:parseDate(text,zone,now);
        if(minute(last)<minute(data.began)) throw new ValidationError('Последняя сигарета должна быть не раньше начала срыва.');
        const nonce=crypto.randomUUID().replaceAll('-','');await save({...data,last,nonce,state:'Form:confirm'});
        const fmt=v=>{const l=local(v,zone);return l.day.split('-').reverse().join('.')+' '+l.clock;};
        return send(`Начало срыва: ${fmt(data.began)}\nПоследняя сигарета: ${fmt(last)}\n`+original('Текущая серия начнётся заново'),confirmation(nonce));
      }
    } catch(e) {if(!(e instanceof ValidationError))throw e;return send(esc(e.message));}
  }
  if(data.state==='Form:confirm') return send(original('Подтвердите запись кнопкой'));
  if(text===A.MENU_LABELS[0]) return progress();
  if([A.MENU_LABELS[1],A.MENU_LABELS[2],A.MENU_LABELS[4]].includes(text)&&!user) return send('Сначала /start.');
  if(text===A.MENU_LABELS[1]) {
    const sec=calculate(await db.streaks(id),now).current_seconds;
    return send(healthReport(sec));
  }
  if(text===A.MENU_LABELS[2]) {
    const awards=new Set((await db.awards(id,now)).map(a=>a.days)),sec=calculate(await db.streaks(id),now).current_seconds;
    return send(['<b>🏆 Достижения</b>','Награды за непрерывную серию остаются после срыва.','',...milestones.map(d=>`${d} дн. — ${awards.has(d)?'🏅 сохранено':'🔒 впереди'}${sec>=d*86400?' · есть в текущей серии':''}`)].join('\n'));
  }
  if(text===A.MENU_LABELS[3]) return send(original('<b>🆘 Переживём'),{inline_keyboard:[[{text:'↩️ Я выкурил(а) сигарету',callback_data:'lapse'}]]});
  if(text===A.MENU_LABELS[4]) {
    const s=(await db.streaks(id)).at(-1),l=local(s.start,user.timezone);
    return send(`<b>⚙️ Настройки</b>\nПоследняя сигарета: ${l.day.split('-').reverse().join('.')} ${l.clock}\n`+
      `Прежний расход: ${user.daily} сиг./день\nПачка: ${user.price} ${user.currency}, ${user.pack} сиг.\n`+
      `Перекур: ${user.minutes} мин.\nПояс: ${esc(user.timezone)}\nОтчёт: ${user.report_time} · ${user.enabled?'включён':'выключен'}`+original('\n\nИзменение расхода, цены'),settings(!!user.enabled));
  }
  return send('Выберите раздел меню или начните с /start.',user?menu():undefined);
}
