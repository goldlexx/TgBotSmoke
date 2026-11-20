// JSON on stdin, SQL on stdout. Both streams contain private IDs: redirect to private/.
import {local,nextDue,dayDue} from '../src/core.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const {users,reports,retries,now}=JSON.parse(input);
for(const u of users) {
  let due=null;
  if(u.enabled) {
    const day=local(now,u.timezone).day,r=reports.find(r=>r.user_id===u.user_id&&r.local_date===day);
    if(r&&!['retry','reserved'].includes(r.status))due=nextDue(now,u.timezone,u.report_time,day);
    else {
      due=dayDue(day,u.timezone,u.report_time);
      if(r?.status==='retry')due=Math.max(due,retries.find(r=>r.user_id===u.user_id&&r.local_date===day)?.retry_at||0);
    }
  }
  if(!Number.isSafeInteger(u.user_id))throw Error('Invalid user ID');
  console.log(`UPDATE users SET next_due_at=${due??'NULL'} WHERE user_id=${u.user_id};`);
}
