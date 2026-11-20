"""Scoped, resumable rollout; preserves the existing webhook and all legacy columns."""
import argparse
import hashlib
import json
import sqlite3
import subprocess
import sys
import socket
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from ops import cf, query, telegram, ACCOUNT, DATABASE, ROOT

STATE=ROOT/'cloudflare/private/audit-rollout.json'
TABLES=['users','streaks','achievements','reports','fsm','report_retries','webhook_updates']
def save(data):STATE.write_text(json.dumps(data,indent=2))
def state():return json.loads(STATE.read_text())
def frozen():
    if query("SELECT value FROM cloud_control WHERE key='active'")[0]['results'][0]['value']!='0':raise RuntimeError('Production must be inactive')
def digest(rows):
    return hashlib.sha256(json.dumps(sorted(json.dumps(r,sort_keys=True) for r in rows)).encode()).hexdigest()
def freeze():
    if STATE.exists() and not state().get('activated'):raise RuntimeError('Existing unfinished rollout; inspect private state')
    info=telegram('getWebhookInfo')
    data={'freeze_at':datetime.now(UTC).isoformat(),'webhook_url':info['url'],'max_connections':info.get('max_connections')}
    query("UPDATE cloud_control SET value='0' WHERE key='active'");save(data)
    print('Production inactive; Telegram will retain webhook retries. Wait 120 seconds before backup.')
def backup():
    frozen();data=state()
    if (datetime.now(UTC)-datetime.fromisoformat(data['freeze_at'])).total_seconds()<120:raise RuntimeError('Drain window has not elapsed')
    if query(f'SELECT count(*) n FROM user_locks WHERE expires>{int(datetime.now(UTC).timestamp()*1000)}')[0]['results'][0]['n']:raise RuntimeError('Active user locks remain')
    target=ROOT/'backups'/('prod-before-audit-'+datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')+'.sql')
    target.parent.mkdir(exist_ok=True)
    cli=ROOT/'cloudflare/node_modules/wrangler/bin/wrangler.js'
    p=subprocess.run(['node',str(cli),'d1','export','tgbot-smoke-db','--remote','--output',str(target)],cwd=ROOT/'cloudflare',capture_output=True,text=True)
    if p.returncode:raise RuntimeError('Production export failed; CLI output suppressed')
    con=sqlite3.connect(':memory:');con.row_factory=sqlite3.Row
    con.executescript(target.read_text(encoding='utf-8'))
    if con.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Backup integrity failed')
    if con.execute('PRAGMA foreign_key_check').fetchall():raise RuntimeError('Backup foreign keys failed')
    baseline={}
    for table in TABLES:
        rows=[dict(r) for r in con.execute('SELECT * FROM '+table)]
        cols=[r[1] for r in con.execute('PRAGMA table_info('+table+')')]
        remote=query('SELECT '+','.join(cols)+' FROM '+table)[0]['results']
        if digest(remote)!=digest(rows):raise RuntimeError('Backup comparison failed: '+table)
        baseline[table]={'columns':cols,'count':len(rows),'digest':digest(rows)}
    data.update(backup=str(target),backup_sha256=hashlib.sha256(target.read_bytes()).hexdigest(),baseline=baseline)
    save(data);print(json.dumps({'backup_verified':True,'file':str(target),'legacy_row_counts':{t:v['count'] for t,v in baseline.items()}}))
def backfill():
    frozen();data=state()
    if not data.get('backup'):raise RuntimeError('Verified backup required')
    payload={'users':query('SELECT * FROM users')[0]['results'],'reports':query('SELECT * FROM reports')[0]['results'],'retries':query('SELECT * FROM report_retries')[0]['results'],'now':int(datetime.now(UTC).timestamp()*1000)}
    p=subprocess.run(['node',str(ROOT/'cloudflare/scripts/backfill.mjs')],input=json.dumps(payload),capture_output=True,text=True)
    if p.returncode:raise RuntimeError('Schedule calculation failed; output suppressed')
    (ROOT/'cloudflare/private/backfill.sql').write_text(p.stdout)
    statements=p.stdout.splitlines()
    for i in range(0,len(statements),25):query('\n'.join(statements[i:i+25]))
    print(json.dumps({'schedules_backfilled':len(statements)}))
def verify():
    frozen();data=state()
    for table,old in data['baseline'].items():
        rows=query('SELECT '+','.join(old['columns'])+' FROM '+table)[0]['results']
        if digest(rows)!=old['digest']:raise RuntimeError('Legacy rows changed: '+table)
    if query('PRAGMA foreign_key_check')[0]['results']:raise RuntimeError('Production foreign keys failed')
    if query('SELECT count(*) n FROM users WHERE enabled=1 AND next_due_at IS NULL')[0]['results'][0]['n']:raise RuntimeError('Unscheduled active users')
    info=telegram('getWebhookInfo')
    if info['url']!=data['webhook_url'] or info.get('max_connections')!=data['max_connections']:raise RuntimeError('Webhook changed')
    data['verified']=True;save(data);print('All legacy rows unchanged; FK, schedule and webhook checks passed')
def activate():
    verify()
    settings=cf(f'/accounts/{ACCOUNT}/workers/scripts/tgbot-smoke/settings')
    if 'global_fetch_strictly_public' not in settings.get('compatibility_flags',[]) or not any(b.get('name')=='WORKER_ORIGIN' and b.get('text')=='https://tgbot-smoke.rustik-yuldashev.workers.dev' for b in settings.get('bindings',[])):raise RuntimeError('Audited Worker not deployed')
    query("UPDATE cloud_control SET value='1' WHERE key='active'")
    data=state();data['activated']=datetime.now(UTC).isoformat();save(data)
    print('Production active; existing webhook unchanged')
def health():
    host='tgbot-smoke.rustik-yuldashev.workers.dev'
    req=urllib.request.Request('https://cloudflare-dns.com/dns-query?name='+host+'&type=A',headers={'Accept':'application/dns-json'})
    with urllib.request.urlopen(req,timeout=15) as r:dns=json.load(r)
    address=next(a['data'] for a in dns['Answer'] if a['type']==1)
    original=socket.getaddrinfo
    socket.getaddrinfo=lambda name,*a,**kw:original(address if name==host else name,*a,**kw)
    req=urllib.request.Request('https://'+host+'/health',headers={'User-Agent':'Mozilla/5.0 TgBotSmokeAudit/1.0'})
    with urllib.request.urlopen(req,timeout=15) as r:result=json.load(r)
    if not result.get('ready') or result.get('active')!=bool(state().get('activated')):raise RuntimeError('Health mismatch')
    info=telegram('getWebhookInfo');data=state()
    if info['url']!=data['webhook_url'] or info.get('max_connections')!=data['max_connections']:raise RuntimeError('Webhook changed')
    print(json.dumps({'health':result,'webhook_unchanged':True,'pending_updates':info.get('pending_update_count')}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['freeze','backup','backfill','verify','activate','health'])
    try:globals()[p.parse_args().action]()
    except Exception as e:
        print('Rollout stopped:',str(e) if isinstance(e,RuntimeError) else type(e).__name__,file=sys.stderr);sys.exit(1)
