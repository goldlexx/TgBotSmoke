// Save only safe timing metadata, never request headers or payloads.
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const production=process.argv.includes('--production');
const args=['--require','./scripts/audit-dns.cjs','node_modules/wrangler/bin/wrangler.js','tail','--config',production?'wrangler.jsonc':'wrangler.audit.jsonc','--format','json'];
if(process.argv.includes('--parent'))args.push('--header','X-Audit-Role:dispatcher');
const cli=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
let buffer='';
cli.stdout.setEncoding('utf8');cli.stdout.on('data',chunk=>{
  buffer+=chunk;
  for(;;){
    const end=buffer.search(/\n}\r?\n/);if(end<0)break;
    const raw=buffer.slice(0,end+2);buffer=buffer.slice(end+2).trimStart();
    try {
      const e=JSON.parse(raw.slice(raw.indexOf('{'))),path=e.event?.cron?'cron:'+e.event.cron:new URL(e.event?.request?.url||'https://invalid/').pathname;
      const row={version:e.scriptVersion?.id,timestamp:e.eventTimestamp,path,cpu_ms:e.cpuTime,wall_ms:e.wallTime,outcome:e.outcome};
      appendFileSync(production?'private/audit-production-timings.jsonl':'private/audit-safe-timings.jsonl',JSON.stringify(row)+'\n');
    }catch{}
  }
});
cli.stderr.on('data',()=>{});
process.on('SIGINT',()=>cli.kill('SIGINT'));
cli.on('exit',code=>process.exit(code||0));
