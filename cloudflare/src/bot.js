import {A,esc,minute,local,stamp,parseDate,parseField,calculate,duration,report,stageLine,menu,choices,settings,confirmation,original,milestones} from './core.js';
export class DeliveryError extends Error {constructor(code,retry=0){super(`Telegram ${code}`);this.code=code;this.retry=retry;}}
export async function telegram(env,method,body) {
  // Never propagate fetch errors: they may contain the token-bearing URL.
  let response;
  try {response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
  catch {throw new DeliveryError(0);}
  let data;
  try {data=await response.json();} catch {throw new DeliveryError(0);}
  if(!data.ok) throw new DeliveryError(data.error_code||response.status,data.parameters?.retry_after||0);
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
    await db.awards(id,now);
    return send(report(await db.streaks(id),now,local(now,user.timezone).day,id),menu());
  };
  if(cb) {
    await api(env,'answerCallbackQuery',{callback_query_id:cb.id});
    const remove=()=>api(env,'editMessageReplyMarkup',{chat_id:m.chat.id,message_id:m.message_id,reply_markup:{inline_keyboard:[]}});
    if(cb.data==='cancel') {await clear();await remove();return send('Отменено.',menu());}
    if(!user) return send('Сначала /start.');
    if(cb.data.startsWith('edit:')) {
      const field=cb.data.split(':')[1];if(!A.FIELDS.includes(field))return;
      await save({state:'Form:value',mode:'edit',field,timezone:user.timezone});await prompt(field);
      if(field==='start') await send(`Время вводите в поясе ${esc(user.timezone)}. Исправление даты пересчитает текущую серию.`);
      return;
    }
    if(cb.data==='lapse') {
      const active=(await db.streaks(id)).at(-1);
      await save({state:'Form:value',mode:'lapse',field:'lapse_begin',timezone:user.timezone,streak_id:active.id});
      await send(original('Срыв не стирает')+`Ваш часовой пояс: ${esc(user.timezone)}.`);return prompt('lapse_begin');
    }
    if(cb.data.startsWith('lapse:confirm:')) {
      if(data.state!=='Form:confirm'||data.mode!=='lapse'||cb.data.split(':').at(-1)!==data.nonce) return send('Эта отметка уже обработана или отменена.');
      try {await db.lapse(id,data.streak_id,data.began,data.last,now);await send(original('Новая серия началась'),menu());}
      catch(e){await send(esc(e.message),menu());}
      await clear();await remove();return;
    }
    return;
  }
  const text=m.text?.trim();
  if(text && /^\/start(?:@\w+)?(?:\s|$)/.test(text)) {
    if(user) {await db.run('UPDATE users SET enabled=1 WHERE user_id=?',id);await clear();return send(original('🚭 <b>НЕ КУРЮ</b>\nВаш прогресс'),menu());}
    if(data.state==='Form:value'&&data.mode==='register') {await send(original('Продолжим регистрацию'));return prompt(data.field);}
    await save({state:'Form:value',mode:'register',field:'start',remaining:A.FIELDS.slice(1),draft:{}});
    await send(original('🚭 <b>НЕ КУРЮ</b>\nПомогу'));return prompt('start');
  }
  if(text==='Отмена'||(text&&/^\/cancel(?:@\w+)?(?:\s|$)/.test(text))) {
    await clear();return send(user?'Ввод отменён.':'Ввод отменён. Начать регистрацию: /start',user?menu():{remove_keyboard:true});
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
        await db.register(id,m.chat.id,draft,now);user=await db.user(id);await clear();
        await send(original('Готово! Отсчёт'),menu());return progress();
      }
      if(mode==='edit') {
        await db.change(id,field,parseField(field,text,zone,now),now);await clear();return send(original('Сохранено. Параметры'),menu());
      }
      if(mode==='lapse') {
        if(field==='lapse_begin') {
          const began=parseDate(text,zone,now),active=(await db.streaks(id)).at(-1);
          if(minute(began)<minute(active.start)) throw Error('Начало срыва не может быть раньше начала текущей серии.');
          await save({...data,began,field:'lapse_last'});return prompt('lapse_last');
        }
        const last=text==='Одна сигарета'?data.began:parseDate(text,zone,now);
        if(minute(last)<minute(data.began)) throw Error('Последняя сигарета должна быть не раньше начала срыва.');
        const nonce=crypto.randomUUID().replaceAll('-','');await save({...data,last,nonce,state:'Form:confirm'});
        const fmt=v=>{const l=local(v,zone);return l.day.split('-').reverse().join('.')+' '+l.clock;};
        return send(`Начало срыва: ${fmt(data.began)}\nПоследняя сигарета: ${fmt(last)}\n`+original('Текущая серия начнётся заново'),confirmation(nonce));
      }
    } catch(e) {if(e instanceof DeliveryError)throw e;return send(esc(e.message));}
  }
  if(data.state==='Form:confirm') return send(original('Подтвердите запись кнопкой'));
  if(text===A.MENU_LABELS[0]) return progress();
  if([A.MENU_LABELS[1],A.MENU_LABELS[2],A.MENU_LABELS[4]].includes(text)&&!user) return send('Сначала /start.');
  if(text===A.MENU_LABELS[1]) {
    const sec=calculate(await db.streaks(id),now).current_seconds;
    const lines=['<b>🫁 Моё здоровье</b>',stageLine(sec),'','<b>Календарь восстановления</b>',...A.STAGES.map(s=>`${sec<s.seconds?'•':'✓'} ${s.label}: ${s.text} <a href="${s.source}">Источник</a>`),'',A.HEALTH_NOTE,'',`<i>${A.MODEL_NOTE}</i> <a href="${A.ADDICTION}">Исследование</a>`];
    return send(lines.join('\n'));
  }
  if(text===A.MENU_LABELS[2]) {
    const awards=new Set((await db.awards(id,now)).map(a=>a.days)),sec=calculate(await db.streaks(id),now).current_seconds;
    return send(['<b>🏆 Достижения</b>','Награды за непрерывную серию остаются после срыва.','',...milestones.map(d=>`${d} дн. — ${awards.has(d)?'🏅 сохранено':'🔒 впереди'}${sec>=d*86400?' · есть в текущей серии':''}`)].join('\n'));
  }
  if(text===A.MENU_LABELS[3]) return send(original('<b>🆘 Переживём'));
  if(text===A.MENU_LABELS[4]) {
    const s=(await db.streaks(id)).at(-1),l=local(s.start,user.timezone);
    return send(`<b>⚙️ Настройки</b>\nПоследняя сигарета: ${l.day.split('-').reverse().join('.')} ${l.clock}\n`+
      `Прежний расход: ${user.daily} сиг./день\nПачка: ${user.price} ${user.currency}, ${user.pack} сиг.\n`+
      `Перекур: ${user.minutes} мин.\nПояс: ${esc(user.timezone)}\nОтчёт: ${user.report_time}`+original('\n\nИзменение расхода, цены'),settings());
  }
  return send('Выберите раздел меню или начните с /start.',user?menu():undefined);
}
