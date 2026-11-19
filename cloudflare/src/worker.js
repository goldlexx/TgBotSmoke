import {Database} from './db.js';
import {local,stamp,report,reportButtons} from './core.js';
import {handleUpdate,telegram,DeliveryError} from './bot.js';

export async function tick(env,now=Date.now(),api=telegram) {
  const db=new Database(env.DB);
  if(!await db.active())return;
  const users=await db.all(`SELECT u.*,r.local_date AS retry_day,r.retry_at FROM users u LEFT JOIN report_retries r ON r.user_id=u.user_id WHERE enabled=1`);
  let sent=0;
  // Small personal bot: at most three deliveries/tick, below free-tier subrequest limits.
  for(const u of users) {
    const l=local(now,u.timezone);
    if(l.clock<u.report_time||(u.retry_day===l.day&&now<u.retry_at))continue;
    const existing=await db.one('SELECT status FROM reports WHERE user_id=? AND local_date=?',u.user_id,l.day);
    if(existing&&existing.status!=='retry')continue;
    if(sent>=3)break;
    const owner=crypto.randomUUID();
    if(!await db.lock(u.user_id,owner,now))continue;
    try {
      const streaks=await db.streaks(u.user_id);
      const text=report(streaks,now,l.day,u.user_id,true);
      if(!await db.claim(u.user_id,l.day,now))continue;
      sent++;
      let status='sent',retry=0;
      try {await api(env,'sendMessage',{chat_id:u.chat_id,text,parse_mode:'HTML',reply_markup:reportButtons(),link_preview_options:{is_disabled:true}});}
      catch(e) {
        if(e instanceof DeliveryError&&e.code===429) {status='retry';retry=now+(e.retry+1)*1000;}
        else if(e instanceof DeliveryError&&e.code===403)status='blocked';
        else if(e instanceof DeliveryError&&e.code===400)status='rejected';
        else status='unknown';
      }
      const writes=[db.stmt('UPDATE reports SET status=? WHERE user_id=? AND local_date=?',status,u.user_id,l.day),...db.awardStatements(u.user_id,streaks,now)];
      if(retry)writes.push(db.stmt('INSERT INTO report_retries VALUES (?,?,?) ON CONFLICT(user_id,local_date) DO UPDATE SET retry_at=excluded.retry_at',u.user_id,l.day,retry));
      else writes.push(db.stmt('DELETE FROM report_retries WHERE user_id=?',u.user_id));
      if(status==='blocked')writes.push(db.stmt('UPDATE users SET enabled=0 WHERE user_id=?',u.user_id));
      await db.batch(writes);
    } finally {await db.unlock(u.user_id,owner);}
  }
  // Bound metadata growth. Keep the report ledger permanently for timezone/dedup safety.
  await db.run("DELETE FROM webhook_updates WHERE created_at < ?",stamp(now-7*86400000));
}
async function authenticated(request,secret) {
  if(!secret)return false;
  const supplied=request.headers.get('X-Telegram-Bot-Api-Secret-Token')||'';
  const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b]=await Promise.all([hash(supplied),hash(secret)]);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname,db=new Database(env.DB);
    if(path==='/health'&&request.method==='GET') {
      try {return Response.json({service:'tgbot-smoke',ready:!!env.BOT_TOKEN&&!!env.WEBHOOK_SECRET,active:await db.active()});}
      catch {return new Response('Unavailable',{status:503});}
    }
    if(path!=='/telegram'||request.method!=='POST')return new Response('Not found',{status:404});
    if(!await authenticated(request,env.WEBHOOK_SECRET))return new Response('Forbidden',{status:403});
    if(!await db.active())return new Response('Not active',{status:503});
    let update;
    try {if(Number(request.headers.get('content-length'))>262144)return new Response('Too large',{status:413});update=await request.json();}
    catch{return new Response('Bad request',{status:400});}
    if(!Number.isSafeInteger(update.update_id))return new Response('Bad update',{status:400});
    const m=update.callback_query?.message||update.message;
    const id=(update.callback_query?.from||m?.from)?.id;
    if(!id||m?.chat?.type!=='private')return new Response('OK');
    const owner=crypto.randomUUID();
    if(!await db.lock(id,owner,Date.now()))return new Response('Busy',{status:503});
    try {
      const claim=await db.run('INSERT OR IGNORE INTO webhook_updates VALUES (?,?)',update.update_id,stamp(Date.now()));
      if(!claim.meta.changes)return new Response('OK');
      try {await handleUpdate(update,db,env);}
      catch {
        // No exception objects or request bodies in logs (token/privacy).
        console.error('Update processing failed');
        try {await telegram(env,'sendMessage',{chat_id:m.chat.id,text:'Не удалось обработать действие. Попробуйте ещё раз или используйте /start. Сохранённые данные остаются в базе.'});}catch{}
      }
      return new Response('OK');
    } finally {await db.unlock(id,owner);}
  },
  async scheduled(event,env,ctx) {ctx.waitUntil(tick(env).catch(()=>console.error('Scheduled reports failed')));}
};
