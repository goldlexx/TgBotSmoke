import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {Database} from '../src/db.js';

export function database({legacy=false}={}) {
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).sort()) {
    if(legacy&&f!=='0001_initial.sql')continue;
    sql.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  }
  const metrics={calls:0,sql:[]};
  let failNext=false;
  const statement=(query,params=[])=>({query,params,
    bind(...p){return statement(query,p);},
    execute(){
      metrics.sql.push(query);
      if(failNext){failNext=false;throw Error('Injected D1 failure');}
      const stmt=sql.prepare(query);
      if(stmt.columns().length)return {results:stmt.all(...params),meta:{changes:0}};
      const r=stmt.run(...params);return {results:[],meta:{changes:Number(r.changes)}};
    },
    async first(){metrics.calls++;return this.execute().results[0]??null;},
    async all(){metrics.calls++;return this.execute();},
    async run(){metrics.calls++;return this.execute();}
  });
  const env={BOT_TOKEN:'123456:test',WEBHOOK_SECRET:'test-secret',DB:{prepare:statement,async batch(stmts){
    metrics.calls++;sql.exec('BEGIN');try{const r=stmts.map(s=>s.execute());sql.exec('COMMIT');return r;}
    catch(e){sql.exec('ROLLBACK');throw e;}
  }}};
  return {env,db:new Database(env.DB),sql,metrics,fail:()=>{failNext=true;}};
}
export const now=Date.parse('2026-11-16T09:00:59Z');
export const profile={daily:20,price:'250',currency:'RUB',pack:20,minutes:'5',timezone:'Europe/Moscow',report_time:'08:00',start:'2026-01-01T07:00:00+00:00'};
export const request=(update,secret='test-secret')=>new Request('https://example.test/telegram',{method:'POST',headers:{'content-type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(update)});
export const message=(id,seq,text,time=now)=>({update_id:seq,message:{message_id:seq,date:Math.floor(time/1000),from:{id},chat:{id,type:'private'},text}});
export const callback=(id,seq,data,time=now)=>({update_id:seq,callback_query:{id:String(seq),from:{id},data,message:{message_id:seq,date:Math.floor(time/1000),chat:{id,type:'private'}}}});
