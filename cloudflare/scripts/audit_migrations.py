"""Migration test with synthetic legacy rows, on a dedicated disposable D1."""
import json
from ops import cf, ACCOUNT, ROOT

DATABASE='116d4bb5-bdfc-4684-bd36-da68f08ad9e2'
assert DATABASE!='0368b28f-dc56-464c-a8a9-b6db823ea14d'
def query(sql):
    return cf(f'/accounts/{ACCOUNT}/d1/database/{DATABASE}/query',{'sql':sql})

query((ROOT/'cloudflare/migrations/0001_initial.sql').read_text(encoding='utf-8'))
query("""
INSERT INTO users VALUES(1,1,20,'250','RUB',20,'5','Europe/Berlin','02:30',1);
INSERT INTO users VALUES(2,2,10,'6','EUR',25,'7','America/New_York','08:00',0);
INSERT INTO streaks VALUES(1,1,'2026-01-01T00:00:00+00:00',NULL,20,'250','RUB',20,'5');
INSERT INTO streaks VALUES(2,2,'2026-01-01T00:00:00+00:00',NULL,10,'6','EUR',25,'7');
INSERT INTO achievements VALUES(1,1,'2026-01-02');
INSERT INTO reports VALUES(1,'2026-11-19','sent','2026-11-19');
INSERT INTO report_retries VALUES(1,'2026-11-20',1795170000000);
INSERT INTO fsm VALUES('synthetic','Form:value','{"field":"daily"}');
INSERT INTO webhook_updates VALUES(17,'2026-11-19');
""")
tables=['users','streaks','achievements','reports','fsm','webhook_updates','report_retries']
before={t:query('SELECT * FROM '+t)[0]['results'] for t in tables}
query((ROOT/'cloudflare/migrations/0002_reliability.sql').read_text(encoding='utf-8'))
for t,expected in before.items():
    columns=','.join(expected[0])
    actual=query(f'SELECT {columns} FROM {t}')[0]['results']
    assert actual==expected,t
assert query('PRAGMA foreign_key_check')[0]['results']==[]
plans=[]
for sql in ["SELECT * FROM users WHERE enabled=1 AND next_due_at<=0 ORDER BY next_due_at,user_id LIMIT 8","SELECT update_id FROM webhook_updates WHERE created_at<'2026' ORDER BY created_at LIMIT 200"]:
    plan=query('EXPLAIN QUERY PLAN '+sql)[0]['results'];assert any('INDEX' in p['detail'] for p in plan),plan;plans.append(plan)
result={'remote_migration':'passed','legacy_rows_preserved':{t:len(v) for t,v in before.items()},'foreign_keys':'passed','query_plans':plans}
(ROOT/'cloudflare/private/audit-migration.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2))
