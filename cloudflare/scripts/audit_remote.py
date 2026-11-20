"""Synthetic-only remote audit. Never sends to Telegram or touches production data."""
import argparse
import json
import secrets
import statistics
import socket
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from ops import cf, ACCOUNT, ROOT

DB = '2de1ac8f-0c1d-412e-858c-af21585dbc33'
WORKER = 'tgbot-smoke-audit-test'
URL = 'https://tgbot-smoke-audit-test.rustik-yuldashev.workers.dev'
PRIVATE = ROOT / 'cloudflare/private'

def query(sql, params=None):
    return cf(f'/accounts/{ACCOUNT}/d1/database/{DB}/query', {'sql': sql, 'params': params or []})

def setup():
    PRIVATE.mkdir(exist_ok=True)
    keyfile = PRIVATE / 'audit-key.txt'
    if not keyfile.exists(): keyfile.write_text(secrets.token_urlsafe(32))
    for name in ['TEST_SECRET', 'WEBHOOK_SECRET']:
        cf(f'/accounts/{ACCOUNT}/workers/scripts/{WORKER}/secrets', {'name':name,'text':keyfile.read_text().strip(),'type':'secret_text'}, method='PUT')
    print('Synthetic test secrets configured')

def call(path, now, update=None, failure=''):
    # Local resolver may time out on workers.dev. Resolve this test hostname via
    # Cloudflare DoH without changing system DNS, TLS hostname, webhook, or domain.
    host=URL.split('/')[2]
    if not hasattr(call,'resolved'):
        req=urllib.request.Request('https://cloudflare-dns.com/dns-query?name='+host+'&type=A',headers={'Accept':'application/dns-json'})
        with urllib.request.urlopen(req,timeout=15) as r: dns=json.load(r)
        address=next(a['data'] for a in dns['Answer'] if a['type']==1)
        original=socket.getaddrinfo
        socket.getaddrinfo=lambda name,*args,**kwargs:original(address if name==host else name,*args,**kwargs)
        call.resolved=True
    key=(PRIVATE/'audit-key.txt').read_text().strip()
    req=urllib.request.Request(URL+path,data=json.dumps(update or {}).encode(),headers={
        'Content-Type':'application/json','User-Agent':'Mozilla/5.0 TgBotSmokeAudit/1.0','X-Telegram-Bot-Api-Secret-Token':key,
        'X-Test-Now':str(int(now.timestamp()*1000)),'X-Test-Failure':failure,'X-Audit-Role':'dispatcher'})
    with urllib.request.urlopen(req,timeout=90) as r: return json.load(r)

def seed(instant=None):
    # Deliberately clustered delivery instant on the European DST overlap.
    instant=instant or datetime(2026,10,25,0,30,tzinfo=UTC)
    zones=['Europe/Berlin','America/New_York','Asia/Tokyo','Asia/Kolkata','Pacific/Auckland','Australia/Sydney','UTC','Europe/Moscow']
    query('CREATE TABLE IF NOT EXISTS test_delivery_log(user_id INTEGER PRIMARY KEY,calls INTEGER NOT NULL,first_sent INTEGER NOT NULL,last_sent INTEGER NOT NULL); DELETE FROM test_delivery_log;')
    query('DELETE FROM delivery_outbox; DELETE FROM achievements; DELETE FROM reports; DELETE FROM streaks; DELETE FROM report_retries; DELETE FROM users; DELETE FROM user_locks; DELETE FROM fsm; DELETE FROM webhook_updates; DELETE FROM rate_limits; DELETE FROM deleted_accounts;')
    for begin in range(1,201,25):
        sql=[]
        for i in range(begin,begin+25):
            zone=zones[i%len(zones)]
            clock=instant.astimezone(ZoneInfo(zone)).strftime('%H:%M')
            sql.append(f"INSERT INTO users(user_id,chat_id,daily,price,currency,pack,minutes,timezone,report_time,next_due_at) VALUES({i},{i},20,'250','RUB',20,'5','{zone}','{clock}',{int(instant.timestamp()*1000)});")
            sql.append(f"INSERT INTO streaks(user_id,start,daily,price,currency,pack,minutes) VALUES({i},'2026-01-01T00:00:00+00:00',20,'250','RUB',20,'5');")
        query(''.join(sql))
    query("UPDATE cloud_control SET value='1' WHERE key='active'")
    return instant

def load():
    instant=seed();ticks=[]
    for n in range(25):
        m=call('/tick',instant+timedelta(minutes=n));ticks.append(m)
        print(json.dumps({'tick':n,'parent_d1_calls':m['d1_calls'],'children':len(m.get('children',[])),'wall_ms':m['wall_ms']}),flush=True)
    rows=query("SELECT status,count(*) n FROM reports GROUP BY status")[0]['results']
    assert rows==[{'status':'sent','n':200}], rows
    duplicates=query('SELECT user_id,count(*) n FROM reports GROUP BY user_id HAVING count(*)>1')[0]['results']
    assert not duplicates
    delivered=query('SELECT count(*) users,sum(calls) sends,min(calls) minimum,max(calls) maximum,max(last_sent)-min(first_sent) span_ms FROM test_delivery_log')[0]['results'][0]
    assert delivered['users']==200 and delivered['sends']==200 and delivered['maximum']==1,delivered
    invocations=[m for tick in ticks for m in [tick,*tick.get('children',[])]]
    totals={k:sum(m[k] for m in invocations) for k in ['d1_calls','statements','rows_read','rows_written','external_subrequests']}
    totals['parent_wall_ms']=sum(m['wall_ms'] for m in ticks)
    result={'environment':'remote Cloudflare Worker + separate remote D1; HTTP Telegram stub, no real Telegram delivery',
        'users':200,'reports_sent':200,'ticks':len(ticks),'totals':totals,
        'max_d1_calls':max(m['d1_calls'] for m in invocations),
        'max_external_subrequests':max(m['external_subrequests'] for m in invocations),
        'max_combined_subrequests':max(m['d1_calls']+m['external_subrequests'] for m in invocations),
        'tick_wall_ms':{'min':min(m['wall_ms'] for m in ticks),'median':statistics.median(m['wall_ms'] for m in ticks),'max':max(m['wall_ms'] for m in ticks)},
        'virtual_delivery_delay_minutes':{'min':0,'max':24},
        'real_delivery_span_ms_accelerated_test':delivered['span_ms'],
        'cpu_ms':'not measured by this HTTP response; requires Cloudflare invocation telemetry',
        'ticks_detail':ticks}
    (PRIVATE/'audit-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k!='ticks_detail'},indent=2))

def scenarios():
    query('DELETE FROM webhook_updates; DELETE FROM deleted_accounts; DELETE FROM rate_limits; DELETE FROM fsm;')
    instant=datetime(2026,11,20,12,tzinfo=UTC);seq=900000;results=[]
    def state():
        rows=query("SELECT data FROM fsm WHERE key='[123456, 990, 990, null, null, \"default\"]'")[0]['results']
        return json.loads(rows[0]['data']) if rows else {}
    def emit(text=None,cb=None,failure='',date=None,repeat=None):
        nonlocal seq,instant
        instant+=timedelta(seconds=11);seq+=1
        msg={'message_id':seq,'chat':{'id':990,'type':'private'},'date':int((date or instant).timestamp())}
        if cb: update={'update_id':seq,'callback_query':{'id':str(seq),'from':{'id':990},'data':cb,'message':msg}}
        else:update={'update_id':seq,'message':{**msg,'from':{'id':990},'text':text}}
        m=call('/telegram',instant,repeat or update,failure);assert m['status']==200,m
        results.append(m);return update
    emit('/start');emit('Сейчас');emit(cb='register:confirm:'+state()['nonce'])
    assert query('SELECT count(*) n FROM users WHERE user_id=990')[0]['results'][0]['n']==1
    u=emit('/privacy');m=call('/telegram',instant,u);assert m['external_subrequests']==0
    emit(cb='notify:off',failure='callback-expired')
    row=query('SELECT enabled,next_due_at FROM users WHERE user_id=990')[0]['results'][0]
    assert row=={'enabled':0,'next_due_at':None},row
    emit('/start');assert query('SELECT enabled FROM users WHERE user_id=990')[0]['results'][0]['enabled']==0
    emit(cb='notify:on');assert query('SELECT enabled FROM users WHERE user_id=990')[0]['results'][0]['enabled']==1
    emit(cb='lapse');nonce=state()['nonce'];u=emit(cb='lapse:confirm:'+nonce)
    emit(repeat=u);emit(cb='lapse:confirm:'+nonce)
    assert query('SELECT count(*) n FROM streaks WHERE user_id=990')[0]['results'][0]['n']==2
    emit('/privacy',failure='send-503')
    queued=query('SELECT id,attempts,due_at FROM delivery_outbox WHERE user_id=990')[0]['results'][0]
    retry_time=datetime.fromtimestamp(queued['due_at']/1000,tz=UTC)
    call('/internal/delivery',retry_time,{'kind':'outbox','id':queued['id']},'send-503')
    assert query('SELECT count(*) n FROM delivery_outbox WHERE user_id=990')[0]['results'][0]['n']==0
    before_delete=instant;emit('/delete');emit(cb='delete:confirm:'+state()['nonce'])
    for table in ['users','streaks','achievements','reports','report_retries','delivery_outbox','webhook_updates','user_locks']:
        assert query(f'SELECT count(*) n FROM {table} WHERE user_id=990')[0]['results'][0]['n']==0,table
    assert not state();emit('/start',date=before_delete);assert not state()
    emit('/start');assert state()['mode']=='register';emit('Отмена')
    (PRIVATE/'audit-scenarios.json').write_text(json.dumps(results,indent=2))
    print(json.dumps({'remote_scenarios':'passed','checks':['registration','duplicate webhook','expired callback','opt-out survives /start','opt-in','lapse idempotency','bounded 503 retry','delete all related rows','ignore old events','fresh /start']}))

def cpu():
    instant=seed(datetime.now(UTC).replace(second=0,microsecond=0));metrics=[]
    for i in range(25):
        m=call('/cpu-tick',instant);metrics.append(m);print(json.dumps({'cpu_tick':i,**m}),flush=True)
    delivered=query('SELECT count(*) users,sum(calls) sends,max(calls) maximum FROM test_delivery_log')[0]['results'][0]
    assert delivered=={'users':200,'sends':200,'maximum':1},delivered
    (PRIVATE/'audit-cpu-run.json').write_text(json.dumps({'deliveries':delivered,'ticks':metrics},indent=2))
    print('Uninstrumented CPU run: 200/200 delivered once; read wrangler tail CPU telemetry')

def concurrent():
    t=datetime.now(UTC)
    # Resolve TLS hostname before starting concurrent callers; no eligible outbox exists.
    call('/internal/delivery',t,{'kind':'outbox','id':-1})
    query('DELETE FROM reports WHERE user_id<=8; DELETE FROM test_delivery_log WHERE user_id<=8; UPDATE users SET next_due_at='+str(int(t.timestamp()*1000))+' WHERE user_id<=8;')
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _:call('/tick',t),range(2)))
    delivered=query('SELECT count(*) users,sum(calls) sends,max(calls) maximum FROM test_delivery_log WHERE user_id<=8')[0]['results'][0]
    assert delivered=={'users':8,'sends':8,'maximum':1},delivered
    (PRIVATE/'audit-concurrent.json').write_text(json.dumps(delivered))
    print('Remote concurrent Cron: two dispatchers, eight due users, eight receipts, no duplicates')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['setup','load','scenarios','cpu','concurrent']);args=p.parse_args()
    try: globals()[args.action]()
    except Exception as e:
        print('Audit failed:',str(e) if isinstance(e,AssertionError) else type(e).__name__,file=sys.stderr)
        if isinstance(e,urllib.error.HTTPError):print('HTTP status:',e.code,'Response:',e.read(500).decode(errors='replace'),file=sys.stderr)
        sys.exit(1)
