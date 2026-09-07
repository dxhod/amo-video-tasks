import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const input=process.argv[2];if(!input)throw new Error('Pass the exact session JSONL path');
const rows=readFileSync(input,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
const meta=rows.find(r=>r.type==='session_meta')?.payload;
if(!meta?.cwd||resolve(meta.cwd).toLowerCase()!==resolve('.').toLowerCase())throw new Error('Session does not belong to this workspace');
const messages=[];
for(const row of rows){const p=row.payload;if(row.type!=='response_item'||p?.type!=='message'||!['user','assistant'].includes(p.role))continue;
 const content=(p.content??[]).filter(c=>['input_text','output_text'].includes(c.type)).map(c=>c.text).join('\n');
 if(!content||content.startsWith('<recommended_plugins>')||content.startsWith('<environment_context>')||content.startsWith('<system-reminder>'))continue;
 if(p.role==='assistant'&&p.channel&&!['final','commentary'].includes(p.channel))continue;
 if(p.role==='user'&&content.startsWith('PLEASE IMPLEMENT THIS PLAN:')){messages.push({role:p.role,time:row.timestamp,text:'PLEASE IMPLEMENT THIS PLAN: [Повний план наведено у попередньому повідомленні асистента; повторний текст тут опущено.]'});continue;}
 const text=content.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[TOKEN REDACTED]').replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g,'');
 messages.push({role:p.role,time:row.timestamp,text});
}
const output=['# Витяг з реальної сесії AI','',`Session: ${meta.id}`,'','Експорт лише повідомлень користувача й видимих відповідей асистента. Системні інструкції, reasoning і виводи інструментів виключені. Дублікат затвердженого плану скорочено з явною позначкою.','',...messages.map(m=>`## ${m.role==='user'?'Користувач':'Асистент'} · ${m.time??''}\n\n${m.text}\n`)].join('\n');
writeFileSync('docs/AI_SESSION_EXCERPT.md',output);console.log(`Exported ${messages.length} visible messages; no tool output included.`);
