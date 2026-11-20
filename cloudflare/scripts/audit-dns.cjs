// Optional process-local DNS fallback for the test-only `wrangler tail` command.
const dns=require('node:dns'),https=require('node:https');
const original=dns.lookup,cache=new Map();
dns.lookup=function(host,options,cb){
  if(typeof options==='function'){cb=options;options={};}
  if(!host.endsWith('.workers.dev'))return original.call(dns,host,options,cb);
  const done=address=>options?.all?cb(null,[{address,family:4}]):cb(null,address,4);
  if(cache.has(host))return process.nextTick(()=>done(cache.get(host)));
  const req=https.get('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(host)+'&type=A',{headers:{Accept:'application/dns-json'}},r=>{
    let raw='';r.on('data',d=>raw+=d);r.on('end',()=>{try{const address=JSON.parse(raw).Answer.find(a=>a.type===1).data;cache.set(host,address);done(address);}catch{cb(Error('Audit DNS failed'));}});
  });req.on('error',()=>cb(Error('Audit DNS unavailable')));
};
