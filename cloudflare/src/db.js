import {local,minute,stamp,milestones,A} from './core.js';
export class Database {
  constructor(db) {this.db=db;}
  stmt(sql,...args) {return this.db.prepare(sql).bind(...args);}
  async one(sql,...args) {return this.stmt(sql,...args).first();}
  async all(sql,...args) {return (await this.stmt(sql,...args).all()).results;}
  async run(sql,...args) {return this.stmt(sql,...args).run();}
  async batch(statements) {if(statements.length) return this.db.batch(statements);}
  user(id) {return this.one('SELECT * FROM users WHERE user_id=?',id);}
  streaks(id) {return this.all('SELECT * FROM streaks WHERE user_id=? ORDER BY id',id);}
  async active() {return (await this.one("SELECT value FROM cloud_control WHERE key='active'"))?.value==='1';}
  async lock(id,owner,now) {
    const r=await this.run('INSERT INTO user_locks VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE expires < ?',id,owner,now+120000,now);
    return r.meta.changes===1;
  }
  unlock(id,owner) {return this.run('DELETE FROM user_locks WHERE user_id=? AND owner=?',id,owner);}
  newStreak(id,start,p) {return this.stmt('INSERT INTO streaks(user_id,start,daily,price,currency,pack,minutes) VALUES (?,?,?,?,?,?,?)',id,start,p.daily,p.price,p.currency,p.pack,p.minutes);}
  skip(id,p,now) {
    const l=local(now,p.timezone);
    return l.clock>=p.report_time?[this.stmt("INSERT OR IGNORE INTO reports VALUES (?,?,'skipped',?)",id,l.day,stamp(now))]:[];
  }
  async register(id,chat,p,now) {
    await this.batch([this.stmt('INSERT INTO users(user_id,chat_id,daily,price,currency,pack,minutes,timezone,report_time) VALUES (?,?,?,?,?,?,?,?,?)',id,chat,...['daily','price','currency','pack','minutes','timezone','report_time'].map(k=>p[k])),this.newStreak(id,p.start,p),...this.skip(id,p,now)]);
  }
  awardStatements(id,streaks,now) {
    const list=[];
    for(const s of streaks) for(const days of milestones) {
      const earned=+new Date(s.start)+days*86400000;
      if(earned<=+new Date(s.end||now)) list.push(this.stmt('INSERT OR IGNORE INTO achievements VALUES (?,?,?)',id,days,stamp(earned)));
    }
    return list;
  }
  async awards(id,now) {
    await this.batch(this.awardStatements(id,await this.streaks(id),now));
    return this.all('SELECT * FROM achievements WHERE user_id=?',id);
  }
  async change(id,field,value,now) {
    if(![...A.FIELDS,'price','currency'].includes(field)) throw Error('Неизвестная настройка.');
    const p=await this.user(id), streaks=await this.streaks(id), active=streaks.at(-1);
    const stmts=this.awardStatements(id,[active],now);
    if(field==='start') {
      let v=minute(value);
      if(v>minute(now)) throw Error('Последняя сигарета не может быть в будущем.');
      const previous=streaks.filter(s=>s.end).at(-1)?.end;
      if(previous&&v<minute(previous)) throw Error('Дата не может быть раньше окончания предыдущей серии.');
      if(previous) v=Math.max(v,+new Date(previous));
      stmts.push(this.stmt('UPDATE streaks SET start=? WHERE id=?',stamp(v),active.id));
    } else if(field==='cost') {
      stmts.push(this.stmt('UPDATE users SET price=?,currency=? WHERE user_id=?',value.price,value.currency,id),this.stmt('UPDATE streaks SET price=?,currency=? WHERE id=?',value.price,value.currency,active.id));
    } else {
      stmts.push(this.stmt(`UPDATE users SET ${field}=? WHERE user_id=?`,value,id));
      if(['daily','pack','minutes'].includes(field)) stmts.push(this.stmt(`UPDATE streaks SET ${field}=? WHERE id=?`,value,active.id));
      if(['report_time','timezone'].includes(field)) stmts.push(...this.skip(id,{...p,[field]:value},now));
    }
    await this.batch(stmts);
  }
  async lapse(id,streakId,began,last,now) {
    let b=minute(began),l=minute(last);
    if(l<b||l>minute(now)) throw Error('Последняя сигарета должна быть не раньше начала срыва и не в будущем.');
    const active=(await this.streaks(id)).at(-1);
    if(active.id!==streakId||active.end) throw Error('Серия уже изменилась. Откройте настройки заново.');
    if(b<minute(active.start)) throw Error('Начало срыва не может быть раньше начала текущей серии.');
    b=Math.max(b,+new Date(active.start));l=Math.max(l,b);
    await this.batch([...this.awardStatements(id,[active],b),this.stmt('UPDATE streaks SET end=? WHERE id=?',stamp(b),active.id),this.newStreak(id,stamp(l),await this.user(id))]);
  }
  fsmKey(id,botId) {return '['+[botId,id,id,null,null,'default'].map(v=>JSON.stringify(v)).join(', ')+']';}
  async state(id,botId) {
    const row=await this.one('SELECT * FROM fsm WHERE key=?',this.fsmKey(id,botId));
    return row?{state:row.state,...JSON.parse(row.data)}:{};
  }
  async saveState(id,botId,data) {
    const {state,...rest}=data;
    if(!state) return this.run('DELETE FROM fsm WHERE key=?',this.fsmKey(id,botId));
    await this.run('INSERT INTO fsm VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,data=excluded.data',this.fsmKey(id,botId),state,JSON.stringify(rest));
  }
  async claim(id,day,now) {
    return (await this.run("INSERT INTO reports VALUES (?,?,'reserved',?) ON CONFLICT(user_id,local_date) DO UPDATE SET status='reserved',created_at=excluded.created_at WHERE reports.status='retry'",id,day,stamp(now))).meta.changes===1;
  }
}
