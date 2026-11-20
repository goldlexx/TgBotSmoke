// Deployed ONLY with wrangler.audit.jsonc, never with the production entry point.
import {tick,webhook,delivery,authenticated,dispatchTask} from '../src/worker.js';
import {DeliveryError} from '../src/bot.js';
export default {
  async fetch(request,env) {
    if(!await authenticated(request,env.TEST_SECRET))return new Response('Forbidden',{status:403});
    const path=new URL(request.url).pathname;
    if(path==='/mock') {
      const {method,body}=await request.json();
      if(request.headers.get('X-Test-Failure')==='callback-expired'&&method==='answerCallbackQuery')return Response.json({ok:false,error_code:400},{status:400});
      if(request.headers.get('X-Test-Failure')==='send-503'&&method==='sendMessage')return Response.json({ok:false,error_code:503},{status:503});
      if(method==='sendMessage')await env.DB.prepare('INSERT INTO test_delivery_log VALUES (?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET calls=calls+1,last_sent=excluded.last_sent').bind(body.chat_id,Date.now(),Date.now()).run();
      return Response.json({ok:true,result:{message_id:1}});
    }
    const metrics={d1_calls:0,statements:0,rows_read:0,rows_written:0,d1_duration_ms:0,external_subrequests:0,stub_statuses:[]};
    const record=r=>{for(const a of Array.isArray(r)?r:[r]){metrics.statements++;metrics.rows_read+=a.meta?.rows_read||0;metrics.rows_written+=a.meta?.rows_written||0;metrics.d1_duration_ms+=a.meta?.duration||0;}return r;};
    const wrap=s=>({raw:s,bind(...args){return wrap(s.bind(...args));},async all(){metrics.d1_calls++;return record(await s.all());},async first(){metrics.d1_calls++;return record(await s.all()).results[0]??null;},async run(){metrics.d1_calls++;return record(await s.run());}});
    const testEnv={...env,DB:{prepare:q=>wrap(env.DB.prepare(q)),async batch(ss){metrics.d1_calls++;return record(await env.DB.batch(ss.map(s=>s.raw)));}}};
    const api=async(e,method,body)=>{
      metrics.external_subrequests++;
      // Real HTTP subrequest to the test-only Telegram stub; no real Telegram IDs/token.
      const r=await fetch(new URL('/mock',request.url),{method:'POST',headers:{'content-type':'application/json','User-Agent':'Mozilla/5.0 TgBotSmokeAudit/1.0','X-Telegram-Bot-Api-Secret-Token':env.TEST_SECRET,'X-Test-Failure':request.headers.get('X-Test-Failure')||''},body:JSON.stringify({method,body})});
      metrics.stub_statuses.push(r.status);
      if(!r.ok)throw new DeliveryError(r.status);return (await r.json()).result;
    };
    // A second CPU-only run removes measurement overhead and returns the same
    // tiny delivery response as production. Stub receipt timestamps remain real.
    const rawApi=async(e,method,body)=>{
      const r=await fetch(new URL('/mock',request.url),{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.TEST_SECRET},body:JSON.stringify({method,body})});
      if(!r.ok)throw new DeliveryError(r.status);return (await r.json()).result;
    };
    if(path==='/cpu-tick') {
      const start=Date.now();
      await tick({...env,WORKER_ORIGIN:new URL(request.url).origin},Date.now(),rawApi,task=>dispatchTask({...env,WORKER_ORIGIN:new URL(request.url).origin},task));
      return Response.json({wall_ms:Date.now()-start});
    }
    if(path==='/internal/delivery'&&!request.headers.has('X-Test-Now')) {
      await delivery(env,await request.json(),Date.now(),rawApi);return new Response('OK');
    }
    const began=Date.now(),now=Number(request.headers.get('X-Test-Now'));
    if(!Number.isSafeInteger(now))return new Response('Missing test time',{status:400});
    metrics.children=[];
    const dispatch=async task=>{
        metrics.external_subrequests++;
        const r=await fetch(new URL('/internal/delivery',request.url),{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.TEST_SECRET,'X-Test-Now':String(now),'X-Test-Failure':request.headers.get('X-Test-Failure')||''},body:JSON.stringify(task)});
        if(!r.ok)throw Error('Test dispatch failed');metrics.children.push(await r.json());
      };
    if(path==='/tick')await tick(testEnv,now,api,dispatch);
    else if(path==='/internal/delivery')await delivery(testEnv,await request.json(),now,api);
    else if(path==='/telegram') {
      const result=await webhook(request,testEnv,now,api,dispatch);metrics.status=result.status;
    }else return new Response('Not found',{status:404});
    return Response.json({...metrics,wall_ms:Date.now()-began});
  }
};
