"""Scoped operations. Secrets travel through stdin or HTTPS, never CLI arguments/logs."""
import argparse
import json
import os
import secrets
import sqlite3
import subprocess
import sys
import tomllib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from dotenv import dotenv_values

ACCOUNT = "e9648642771612b9c00aaa73c74f3020"
DATABASE = "0368b28f-dc56-464c-a8a9-b6db823ea14d"
def cf(path, body=None, method=None):
    config = Path(os.environ["APPDATA"]) / "xdg.config/.wrangler/config/default.toml"
    token = tomllib.loads(config.read_text(encoding="utf-8"))["oauth_token"]
    req = urllib.request.Request("https://api.cloudflare.com/client/v4" + path, data=json.dumps(body).encode() if body is not None else None, headers={"Authorization": "Bearer " + token, "Content-Type":"application/json"}, method=method)
    with urllib.request.urlopen(req, timeout=90) as r:
        data = json.load(r)
    if not data["success"]: raise RuntimeError("Cloudflare request failed")
    return data["result"]

def query(sql):
    return cf(f"/accounts/{ACCOUNT}/d1/database/{DATABASE}/query", {"sql":sql})

def verify_data():
    with sqlite3.connect(ROOT / "data/smoke.sqlite3") as con:
        con.row_factory=sqlite3.Row
        counts={}
        for table in ("users","streaks","achievements","reports","fsm"):
            local=[dict(r) for r in con.execute(f"SELECT * FROM {table}")]
            remote=query(f"SELECT * FROM {table}")[0]["results"]
            canonical=lambda rows:sorted(json.dumps(r,sort_keys=True,ensure_ascii=True) for r in rows)
            if canonical(local)!=canonical(remote): raise RuntimeError(f"Data mismatch: {table}; do not activate")
            counts[table]=len(local)
    print(json.dumps({"data_match":True,"counts":counts}))

def telegram(method, body=None):
    token = dotenv_values(ROOT / ".env").get("BOT_TOKEN", "")
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}",data=json.dumps(body or {}).encode(),headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req,timeout=15) as r: data=json.load(r)
    except Exception: raise RuntimeError("Telegram request failed; URL suppressed") from None
    if not data.get("ok"): raise RuntimeError("Telegram rejected request")
    return data["result"]

def main(action):
    private = ROOT / "cloudflare/private"
    if action == "inspect":
        print(json.dumps({"zones": [{"id":z["id"],"name":z["name"],"status":z["status"]} for z in cf("/zones?name=goldlexx.ru")]}))
    elif action == "status":
        info=telegram("getWebhookInfo")
        print(json.dumps({k:info.get(k) for k in ("url","pending_update_count","last_error_message","max_connections")}))
    elif action == "verify":
        verify_data()
    elif action == "secrets":
        private.mkdir(exist_ok=True)
        key = private / "webhook-secret.txt"
        if not key.exists(): key.write_text(secrets.token_urlsafe(32),encoding="ascii")
        payload={"BOT_TOKEN":dotenv_values(ROOT / ".env")["BOT_TOKEN"],"WEBHOOK_SECRET":key.read_text().strip()}
        # Capture all CLI output defensively; print only the exit code.
        cli=Path(os.environ["APPDATA"])/"npm/node_modules/wrangler/bin/wrangler.js"
        p=subprocess.run(["node",str(cli),"secret","bulk"],input=json.dumps(payload),text=True,cwd=ROOT/"cloudflare",capture_output=True)
        print("Secrets upload exit:",p.returncode)
        if p.returncode: raise RuntimeError("Secret upload failed; output suppressed")
    elif action == "activate":
        if not (private / "cutover-approved").exists():
            raise RuntimeError("First agree local shutdown with the user; then create private/cutover-approved")
        # Never activate while a local polling process is still running.
        check=subprocess.run(["powershell","-NoProfile","-Command","Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python' -and $_.CommandLine -match '(?:-m\\s+smoke|smoke[\\\\/]__main__\\.py)' } | Select-Object -ExpandProperty ProcessId"],capture_output=True,text=True)
        if check.returncode or check.stdout.strip(): raise RuntimeError("Stop the local bot before activating")
        verify_data()
        from backup import backup
        backup(ROOT / "data/smoke.sqlite3",ROOT / "backups")
        secret=(private / "webhook-secret.txt").read_text().strip()
        query("UPDATE cloud_control SET value='1' WHERE key='active'")
        try:
            telegram("setWebhook",{"url":"https://tgbot-smoke.rustik-yuldashev.workers.dev/telegram","secret_token":secret,"max_connections":1,"allowed_updates":["message","callback_query"],"drop_pending_updates":False})
        except Exception:
            query("UPDATE cloud_control SET value='0' WHERE key='active'")
            raise
        print("Webhook configured; pending updates preserved")

if __name__ == "__main__":
    p=argparse.ArgumentParser();p.add_argument("action",choices=["inspect","status","secrets","activate","verify"])
    try: main(p.parse_args().action)
    except Exception as exc:
        print("Operation failed:",str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__,file=sys.stderr)
        sys.exit(1)
