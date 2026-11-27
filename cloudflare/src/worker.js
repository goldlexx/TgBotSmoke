import {Database} from './db.js';
import {local,stamp,nextDue,dayDue,calculate,lastMilestone,morningReport} from './core.js';
import {handleUpdate,telegram,DeliveryError} from './bot.js';

// Production: dispatcher <=6 D1 calls +8 public HTTP loopbacks =14 subrequests.
// Each child: active + candidate + lock + read batch + claim batch + finish batch
// + Telegram =7 subrequests. Separate HTTP invocations have separate CPU budgets.
// Direct in-process tick is used only by unit tests (<=46 combined subrequests).
export const TICK_LIMIT=8;
const LEASE=120000;
export function deliveryResult(error,attempts,now) {
  if(!error)return {status:'sent',retry:0};
  if(error instanceof DeliveryError) {
    if(error.code===429&&attempts<4)return {status:'retry',retry:now+Math.max(60000,(error.retry+1)*1000)};
    if((error.code===0||error.code>=500)&&attempts<2)return {status:'retry',retry:now+60000};
    if(error.code===403)return {status:'blocked',retry:0};
    if(error.code===400||error.code===429)return {status:'rejected',retry:0};
  }
  return {status:'unknown',retry:0};
}
async function deliverReport(db,env,candidate,now,api) {
  const id=candidate.user_id,owner=crypto.randomUUID();
  if(!await db.lock(id,owner,now,true))return;
  let finished=false;
  try {
    const day=local(now,candidate.timezone).day;
    const rows=await db.db.batch([
      db.stmt('SELECT * FROM users WHERE user_id=?',id),
      db.stmt('SELECT * FROM streaks WHERE user_id=? ORDER BY id',id),
      db.stmt('SELECT * FROM reports WHERE user_id=? AND local_date=?',id,day),
      db.stmt('SELECT milestone FROM reports WHERE user_id=? AND milestone IS NOT NULL',id)
    ]);
    const u=rows[0].results[0],streaks=rows[1].results,previous=rows[2].results[0];
    if(!u?.enabled||u.next_due_at==null||u.next_due_at>now||u.timezone!==candidate.timezone)return;
    // Never turn yesterday's backlog/retry into an early notification today.
    const todayDue=dayDue(day,u.timezone,u.report_time);
    if(todayDue>now){await db.run('UPDATE users SET next_due_at=? WHERE user_id=?',todayDue,id);return;}
    const next=nextDue(now,u.timezone,u.report_time,day);
    if(previous&&(!['retry','reserved'].includes(previous.status)||(previous.status==='reserved'&&previous.attempts>=2))) {
      await db.run('UPDATE users SET next_due_at=? WHERE user_id=?',next,id);return;
    }
    const stats=calculate(streaks,now),attempts=(previous?.attempts||0)+1;
    const reached=lastMilestone(stats.current_seconds);
    let milestone=null;
    if(reached&&!previous?.milestone&&!rows[3].results.some(row=>row.milestone===reached)) {
      const yesterday=Date.parse(day)-86400000;
      const crossed=+new Date(streaks.at(-1).start)+reached*86400000;
      // Skip the IANA conversion for old milestones, even at the largest UTC offsets.
      if(crossed>yesterday-86400000&&crossed>dayDue(new Date(yesterday).toISOString().slice(0,10),u.timezone,u.report_time))milestone=reached;
    }
    const report=morningReport(stats,now,u.timezone,id,streaks.at(-1)?.start,milestone);
    // Reservation + retry lease are atomic and survive a terminated invocation.
    await db.batch([
      db.stmt("INSERT INTO reports(user_id,local_date,status,created_at,attempts,milestone) VALUES (?,?,'reserved',?,?,?) ON CONFLICT(user_id,local_date) DO UPDATE SET status='reserved',created_at=excluded.created_at,attempts=excluded.attempts,milestone=COALESCE(reports.milestone,excluded.milestone)",id,day,stamp(now),attempts,milestone),
      db.stmt('UPDATE users SET next_due_at=? WHERE user_id=?',now+LEASE,id)
    ]);
    let error;
    try {await api(env,'sendMessage',{chat_id:u.chat_id,...report,parse_mode:'HTML',link_preview_options:{is_disabled:true}});}catch(e){error=e;}
    const {status,retry}=deliveryResult(error,attempts,now);
    await db.batch([
      // Telegram explicitly rejected a 429; ambiguous timeouts must keep the reservation.
      db.stmt('UPDATE reports SET status=?,milestone=CASE WHEN ? THEN NULL ELSE milestone END WHERE user_id=? AND local_date=?',status,milestone!==null&&error instanceof DeliveryError&&error.code===429?1:0,id,day),
      db.stmt('UPDATE users SET next_due_at=?,enabled=? WHERE user_id=?',status==='blocked'?null:retry||next,status==='blocked'?0:1,id),
      db.stmt('DELETE FROM report_retries WHERE user_id=?',id),
      db.stmt("UPDATE reports SET status='expired' WHERE user_id=? AND local_date<? AND status IN ('reserved','retry')",id,day),
      ...db.awardStatements(id,streaks,now),
      db.stmt('DELETE FROM user_locks WHERE user_id=? AND owner=?',id,owner)
    ]);finished=true;
  }finally {if(!finished)await db.unlock(id,owner);}
}
export async function drainOutbox(db,env,now,api=telegram,limit=TICK_LIMIT,updateId=null) {
  const rows=await db.all(`SELECT * FROM delivery_outbox WHERE status IN ('ready','retry','sending') AND due_at<=? ${updateId===null?'':'AND update_id=?'} ORDER BY due_at,id LIMIT ?`,...(updateId===null?[now,limit]:[now,updateId,limit]));
  for(const row of rows)await deliverOutbox(db,env,row,now,api);
}
async function deliverOutbox(db,env,row,now,api) {
  const owner=crypto.randomUUID();
  if(!await db.lock(row.user_id,owner,now))return;
  let finished=false;
  try {
    const claimed=await db.one(`UPDATE delivery_outbox SET status='sending',attempts=attempts+1,due_at=?
      WHERE id=? AND status IN ('ready','retry','sending') AND due_at<=?
      AND NOT EXISTS(SELECT 1 FROM delivery_outbox p WHERE p.user_id=delivery_outbox.user_id AND p.id<delivery_outbox.id AND p.status IN ('ready','retry','sending')) RETURNING *`,now+LEASE,row.id,now);
    if(!claimed)return;
    let error;
    if(row.status==='sending'&&row.attempts>=2)error=new DeliveryError(0);
    else try {await api(env,claimed.method,JSON.parse(claimed.body));}catch(e){error=e;}
    const result=deliveryResult(error,claimed.attempts,now);
    await db.batch([
      ...(result.retry?[db.stmt('UPDATE delivery_outbox SET status=?,due_at=? WHERE id=?',result.status,result.retry,row.id)]:[db.stmt('DELETE FROM delivery_outbox WHERE id=?',row.id)]),
      db.stmt('DELETE FROM user_locks WHERE user_id=? AND owner=?',row.user_id,owner)
    ]);finished=true;
  }finally {if(!finished)await db.unlock(row.user_id,owner);}
}
export async function delivery(env,task,now=Date.now(),api=telegram) {
  const db=new Database(env.DB);
  // The authenticated dispatcher already knows the zone. Revalidate against the
  // profile under the active-gated user lock; avoid two extra D1 round trips.
  if(task.kind==='report'&&typeof task.timezone==='string') {
    await deliverReport(db,env,{user_id:task.id,timezone:task.timezone},now,api);return;
  }
  if(!await db.active())return;
  if(task.kind==='report') {
    const u=await db.user(task.id);if(u)await deliverReport(db,env,u,now,api);
  }else if(task.kind==='outbox') {
    const row=await db.one('SELECT * FROM delivery_outbox WHERE id=?',task.id);
    if(row)await deliverOutbox(db,env,row,now,api);
  }
}
export async function tick(env,now=Date.now(),api=telegram,dispatch=null) {
  const db=new Database(env.DB);
  if(!await db.active())return;
  // Normally empty: backfill before rollout. This is bounded legacy-row recovery.
  const bootstrap=await db.all('SELECT * FROM users WHERE enabled=1 AND next_due_at IS NULL ORDER BY user_id LIMIT 4');
  if(bootstrap.length)await db.batch(bootstrap.map(u=>db.stmt('UPDATE users SET next_due_at=? WHERE user_id=? AND next_due_at IS NULL',nextDue(now,u.timezone,u.report_time),u.user_id)));
  const due=await db.all('SELECT * FROM users WHERE enabled=1 AND next_due_at<=? ORDER BY next_due_at,user_id LIMIT ?',now,TICK_LIMIT);
  const out=await db.all("SELECT * FROM delivery_outbox o WHERE status IN ('ready','retry','sending') AND due_at<=? AND NOT EXISTS(SELECT 1 FROM delivery_outbox p WHERE p.user_id=o.user_id AND p.id<o.id AND p.status IN ('ready','retry','sending')) ORDER BY due_at,id LIMIT ?",now,TICK_LIMIT);
  const work=[...due.map(u=>({kind:'report',due:u.next_due_at,row:u})),...out.map(o=>({kind:'outbox',due:o.due_at,row:o}))].sort((a,b)=>a.due-b.due).slice(0,TICK_LIMIT);
  for(const task of work) {
    if(dispatch)await dispatch({kind:task.kind,id:task.kind==='report'?task.row.user_id:task.row.id,...(task.kind==='report'?{timezone:task.row.timezone}:{})});
    else if(task.kind==='report')await deliverReport(db,env,task.row,now,api);
    else await deliverOutbox(db,env,task.row,now,api);
  }
  if(Math.floor(now/60000)%60===0)await db.batch([
    db.stmt('DELETE FROM webhook_updates WHERE update_id IN (SELECT update_id FROM webhook_updates WHERE created_at<? ORDER BY created_at LIMIT 200)',stamp(now-7*86400000)),
    db.stmt('DELETE FROM rate_limits WHERE subject IN (SELECT subject FROM rate_limits WHERE window<? ORDER BY window LIMIT 200)',Math.floor(now/60000)-60),
    db.stmt('DELETE FROM delivery_outbox WHERE id IN (SELECT id FROM delivery_outbox WHERE created_at<? ORDER BY created_at LIMIT 200)',now-7*86400000)
  ]);
}
export async function authenticated(request,secret) {
  if(!secret)return false;
  const supplied=request.headers.get('X-Telegram-Bot-Api-Secret-Token')||'';
  const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([hash(supplied),hash(secret)]);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
let hmacSecret,hmacKey;
async function subjectFor(id,secret) {
  if(hmacSecret!==secret){hmacSecret=secret;hmacKey=crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);}
  const key=await hmacKey;
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(String(id))))).map(v=>v.toString(16).padStart(2,'0')).join('');
}
const bursts=new Map();
function spam(id,now) {
  const window=Math.floor(now/10000),p=bursts.get(id);
  if(bursts.size>=2048)bursts.clear();
  const count=p?.window===window?p.count+1:1;bursts.set(id,{window,count});
  return count>8;
}
export async function webhook(request,env,now=Date.now(),api=telegram,dispatch=null) {
  const db=new Database(env.DB);
  if(!await authenticated(request,env.WEBHOOK_SECRET))return new Response('Forbidden',{status:403});
  let update;
  try {
    if(Number(request.headers.get('content-length'))>262144)return new Response('Too large',{status:413});
    const body=await request.text();if(body.length>262144)return new Response('Too large',{status:413});update=JSON.parse(body);
  }catch{return new Response('Bad request',{status:400});}
  if(!Number.isSafeInteger(update.update_id))return new Response('Bad update',{status:400});
  const m=update.callback_query?.message||update.message,id=(update.callback_query?.from||m?.from)?.id;
  if(!Number.isSafeInteger(id)||m?.chat?.type!=='private'||id!==m.chat.id)return new Response('OK');
  if(!update.callback_query&&(!Number.isSafeInteger(m.date)||m.date<now/1000-86400))return new Response('OK');
  const admin=!update.callback_query&&typeof m.text==='string'&&/^\/admin(?:@[A-Za-z0-9_]+)?$/.test(m.text.trim());
  if(admin&&(id<=0||env.OWNER_CHAT_ID!==String(id)))return new Response('OK');
  if(spam(id,now))return new Response('OK');
  if(!await db.active())return new Response('Not active',{status:503});
  const owner=crypto.randomUUID();
  if(!await db.lock(id,owner,now))return new Response('Busy',{status:503});
  let released=false;
  try {
    db.subject=await subjectFor(id,env.WEBHOOK_SECRET);
    const botId=Number(env.BOT_TOKEN.split(':')[0]);
    const initial=await db.db.batch([
      db.stmt('SELECT update_id FROM webhook_updates WHERE update_id=?',update.update_id),
      ...(!admin?[
        db.stmt('SELECT deleted_at FROM deleted_accounts WHERE subject=?',db.subject),
        db.stmt('SELECT * FROM fsm WHERE key=?',db.fsmKey(id,botId)),
        db.stmt('SELECT * FROM users WHERE user_id=?',id)
      ]:[]),
      db.stmt('INSERT INTO rate_limits SELECT ?,?,1 WHERE NOT EXISTS(SELECT 1 FROM webhook_updates WHERE update_id=?) ON CONFLICT(subject) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END WHERE window!=excluded.window OR count<12 RETURNING count',db.subject,Math.floor(now/60000),update.update_id)
    ]);
    if(initial[0].results.length)return new Response('OK');
    if(!initial.at(-1).results.length)return new Response('OK');
    const replies=[],cosmetic=[];db.begin();
    if(admin) {
      const {registered,subscribed,eligible}=await db.one(`SELECT COUNT(*) AS registered,
        COUNT(*) FILTER (WHERE enabled=1) AS subscribed,
        COUNT(*) FILTER (WHERE enabled=1 AND EXISTS (
          SELECT 1 FROM cloud_control WHERE key='active' AND value='1'
        )) AS eligible FROM users`);
      const lines=['📊 <b>Статистика бота</b>','',`👥 Пользователей в базе: ${registered}`,
        `✅ Завершили регистрацию: ${registered}`,`🔔 Включили уведомления: ${subscribed}`,
        `📨 Могут получать автоматические отчёты: ${eligible}`];
      if(registered>=200)lines.push('','⚠️ Пора проверить пропускную способность рассылки.');
      replies.push({method:'sendMessage',body:{chat_id:id,text:lines.join('\n'),parse_mode:'HTML'}});
    }else {
      const fsm=initial[2].results[0];
      db.preloaded={id,user:initial[3].results[0]||null,state:fsm?{state:fsm.state,...JSON.parse(fsm.data)}:{}};
      const deleted=initial[1].results[0];
      if(deleted) {
        if(!m.date||m.date<=deleted.deleted_at)return new Response('OK');
        if(!db.preloaded.user&&!/^\/start(?:@\w+)?(?:\s|$)/.test(m.text||'')&&!fsm)return new Response('OK');
      }
      await handleUpdate(update,db,env,now,async(e,method,body)=>{
        if(method==='answerCallbackQuery'){try {await api(e,method,body);}catch{}return;}
        if(method==='sendMessage')replies.push({method,body});else cosmetic.push({method,body});
      });
    }
    const committed=await db.commit([
      db.stmt('INSERT INTO webhook_updates(update_id,created_at,user_id) VALUES (?,?,?)',update.update_id,stamp(now),db.deleting?null:id),
      ...(!db.deleting?replies.map((r,i)=>db.stmt('INSERT INTO delivery_outbox(update_id,user_id,sequence,method,body,due_at,created_at) VALUES (?,?,?,?,?,?,?) RETURNING id',update.update_id,id,i,r.method,JSON.stringify(r.body),now,now)):[])
    ]);
    for(const r of cosmetic){try {await api(env,r.method,r.body);}catch{}}
    await db.unlock(id,owner);released=true;
    if(db.deleting){for(const r of replies){try {await api(env,r.method,r.body);}catch{}}}
    else if(dispatch) {
      const queued=replies.length?committed.slice(-replies.length).flatMap(r=>r.results):[];
      for(const r of queued)await dispatch({kind:'outbox',id:r.id});
    }else await drainOutbox(db,env,now,api,4,update.update_id);
    return new Response('OK');
  }catch {
    console.error('Update processing failed');
    return new Response('Retry',{status:503});
  }finally {if(!released)await db.unlock(id,owner);}
}
export async function dispatchTask(env,task) {
  const response=await fetch(new URL('/internal/delivery',env.WORKER_ORIGIN),{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(task),signal:AbortSignal.timeout(25000)});
  await response.arrayBuffer();if(!response.ok)throw Error('Delivery dispatch failed');
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path==='/health'&&request.method==='GET') {
      try {return Response.json({service:'tgbot-smoke',ready:!!env.BOT_TOKEN&&!!env.WEBHOOK_SECRET,active:await new Database(env.DB).active()});}
      catch{return new Response('Unavailable',{status:503});}
    }
    if(path==='/internal/delivery'&&request.method==='POST') {
      if(!await authenticated(request,env.WEBHOOK_SECRET))return new Response('Forbidden',{status:403});
      const raw=await request.text();if(raw.length>1024)return new Response('Too large',{status:413});
      let task;try {task=JSON.parse(raw);}catch{return new Response('Bad task',{status:400});}
      if(!['report','outbox'].includes(task.kind)||!Number.isSafeInteger(task.id))return new Response('Bad task',{status:400});
      await delivery(env,task);return new Response('OK');
    }
    if(path!=='/telegram'||request.method!=='POST')return new Response('Not found',{status:404});
    return webhook(request,env,Date.now(),telegram,task=>dispatchTask(env,task));
  },
  async scheduled(event,env,ctx) {
    // Public HTTP loopback creates a separate Free CPU budget per delivery.
    // Service bindings share CPU accounting and would not solve this limit.
    ctx.waitUntil(tick(env,Date.now(),telegram,task=>dispatchTask(env,task)).catch(()=>console.error('Scheduled reports failed')));
  }
};
