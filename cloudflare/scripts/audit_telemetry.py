"""Read only invocation CPU telemetry for the synthetic audit Worker."""
import json
import time
import statistics
import urllib.error
from urllib.parse import urlsplit
from ops import cf, ACCOUNT, ROOT

tails=list((ROOT/'cloudflare/private').glob('audit*tail.json'))
if tails:
    events=[];decoder=json.JSONDecoder()
    for tail in tails:
      raw=tail.read_text(encoding='utf-8-sig')
      while raw.strip():
        raw=raw.lstrip()
        try: event,pos=decoder.raw_decode(raw)
        except json.JSONDecodeError:break
        raw=raw[pos:];events.append(event)
    # Concurrent tails can contain the same invocation. Do not count it twice.
    unique={}
    for e in events:
        key=(e.get('scriptVersion',{}).get('id',''),e.get('eventTimestamp'),e.get('event',{}).get('request',{}).get('url',''))
        unique[key]=e
    events=list(unique.values())
    # A tail may span redeployments; report each version independently.
    versions=sorted(set(e.get('scriptVersion',{}).get('id','') for e in events))
    summary=[]
    for version in versions:
      for path in ['/tick','/cpu-tick','/telegram','/internal/delivery']:
        matches=[e for e in events if e.get('scriptVersion',{}).get('id','')==version and urlsplit(e.get('event',{}).get('request',{}).get('url','')).path==path]
        if not matches:continue
        cpu=[e['cpuTime'] for e in matches if 'cpuTime' in e]
        summary.append({'version':version,'path':path,'samples':len(matches),'max_cpu_ms':max(cpu) if cpu else None,'median_cpu_ms':statistics.median(cpu) if cpu else None,'min_cpu_ms':min(cpu) if cpu else None,'outcomes':sorted(set(e.get('outcome','') for e in matches))})
    (ROOT/'cloudflare/private/audit-cpu-summary.json').write_text(json.dumps(summary,indent=2))
    print(json.dumps(summary,indent=2));raise SystemExit

end=int(time.time()*1000)
body={'queryId':'tgbot-smoke-audit','timeframe':{'from':end-3600000,'to':end},'view':'events','limit':2000,
      'parameters':{'datasets':['cloudflare-workers'],'filterCombination':'and','filters':[
          {'key':'$workers.scriptName','operation':'eq','type':'string','value':'tgbot-smoke-audit-test'}]}}
try:
    result=cf(f'/accounts/{ACCOUNT}/workers/observability/telemetry/query',body)
    (ROOT/'cloudflare/private/audit-telemetry.json').write_text(json.dumps(result))
    def walk(x):
        if isinstance(x,dict):
            if 'cpuTimeMs' in x: yield {k:x.get(k) for k in ['cpuTimeMs','wallTimeMs','outcome','scriptName','event']}
            for v in x.values():yield from walk(v)
        elif isinstance(x,list):
            for v in x:yield from walk(v)
    rows=list(walk(result));cpu=[r['cpuTimeMs'] for r in rows]
    print(json.dumps({'samples':len(cpu),'max_cpu_ms':max(cpu) if cpu else None,'invocations':rows},indent=2))
except urllib.error.HTTPError as e:
    print('Telemetry API status:',e.code,'response:',e.read(800).decode(errors='replace'))
