create extension if not exists pgmq;
select pgmq.create('video');

create table public.profiles (id uuid primary key references auth.users on delete cascade, display_name text not null default '', created_at timestamptz not null default now());
create table public.projects (id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 120), created_by uuid not null references profiles, created_at timestamptz not null default now());
create table public.project_members (project_id uuid references projects on delete cascade, user_id uuid references profiles, role text not null check(role in ('admin','member')), primary key(project_id,user_id));
create table public.tasks (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references projects, title text not null check(length(title) between 1 and 160), description text not null default '' check(length(description)<=10000),
 status text not null default 'todo' check(status in ('todo','in_progress','review','done')), assignee_id uuid, reviewer_id uuid, current_version_id uuid, completed_by uuid references profiles, completed_at timestamptz,
 created_by uuid not null references profiles, created_at timestamptz not null default now(),
 foreign key(project_id,assignee_id) references project_members(project_id,user_id), foreign key(project_id,reviewer_id) references project_members(project_id,user_id), unique(id,project_id)
);
create table public.task_events (id uuid primary key default gen_random_uuid(), task_id uuid not null references tasks, user_id uuid references profiles, from_status text, to_status text not null, created_at timestamptz not null default now());
create table public.comments (id uuid primary key default gen_random_uuid(), task_id uuid not null references tasks, user_id uuid not null references profiles, body text not null check(length(body) between 1 and 5000), created_at timestamptz not null default now());
create table public.media_assets (
 id uuid primary key default gen_random_uuid(), task_id uuid not null, project_id uuid not null, user_id uuid not null references profiles, source_path text not null unique, canonical_path text,
 status text not null default 'uploading' check(status in ('uploading','queued','processing','ready','failed')), mime text not null, bytes bigint not null check(bytes between 1 and 52428800),
 duration double precision, frames integer, has_audio boolean not null default false, created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours',
 foreign key(task_id,project_id) references tasks(id,project_id), unique(id,task_id)
);
create unique index one_live_asset on media_assets(task_id) where status<>'failed';
create table public.detected_scenes (id uuid primary key default gen_random_uuid(), asset_id uuid not null references media_assets, start_frame integer not null, end_frame integer not null, thumbnail_path text not null, check(start_frame>=0 and end_frame>start_frame));
create table public.edit_versions (
 id uuid primary key default gen_random_uuid(), task_id uuid not null references tasks, asset_id uuid not null, number integer not null, timeline jsonb not null,
 revision integer not null default 1, locked_at timestamptz, created_by uuid not null references profiles, created_at timestamptz not null default now(),
 foreign key(asset_id,task_id) references media_assets(id,task_id), unique(task_id,number), unique(id,task_id)
);
alter table tasks add constraint current_version_belongs_to_task foreign key(current_version_id,id) references edit_versions(id,task_id);
create table public.processing_jobs (
 id uuid primary key default gen_random_uuid(), task_id uuid not null references tasks, asset_id uuid not null, version_id uuid, user_id uuid not null references profiles,
 kind text not null check(kind in ('analyze','render')), status text not null default 'queued' check(status in ('queued','running','succeeded','failed')), stage text not null default 'queued',
 snapshot jsonb, attempt integer not null default 0, msg_id bigint, lease_until timestamptz, progress integer not null default 0 check(progress between 0 and 100),
 started_at timestamptz, finished_at timestamptz, render_ms integer, error_code text, created_at timestamptz not null default now(),
 foreign key(asset_id,task_id) references media_assets(id,task_id), foreign key(version_id,task_id) references edit_versions(id,task_id), unique(id,task_id),
 check((kind='render' and version_id is not null and snapshot is not null) or (kind='analyze' and version_id is null))
);
create unique index one_render_job on processing_jobs(version_id) where kind='render';
create unique index one_analysis_job on processing_jobs(asset_id) where kind='analyze';
create table public.renders (id uuid primary key default gen_random_uuid(), version_id uuid not null unique references edit_versions, job_id uuid not null references processing_jobs, path text not null unique, duration double precision not null, created_at timestamptz not null default now());
create table public.error_logs (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), project_id uuid references projects, task_id uuid references tasks, job_id uuid references processing_jobs, user_id uuid references profiles, stage text not null, type text not null, message text not null, stack_trace text, critical boolean not null default false, request_id uuid);
create table public.notification_outbox (id uuid primary key default gen_random_uuid(), error_id uuid not null unique references error_logs, attempts integer not null default 0, next_at timestamptz not null default now(), sent_at timestamptz, lease_token uuid, lease_until timestamptz, last_error text);
create table public.worker_heartbeats (id text primary key, updated_at timestamptz not null default now());
create table public.command_keys (user_id uuid not null references profiles, key text not null, action text not null, target text not null, result jsonb not null, primary key(user_id,key));
create index task_project on tasks(project_id);
create index job_task on processing_jobs(task_id);
create index errors_project_date on error_logs(project_id,created_at desc);
create index comment_task on comments(task_id,created_at);

create function public.create_profile() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin insert into profiles(id,display_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'display_name',split_part(new.email,'@',1),'Користувач'),100)); return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.create_profile();

create function public.is_member(p uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select exists(select 1 from project_members where project_id=p and user_id=auth.uid()) $$;
create function public.is_admin(p uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select exists(select 1 from project_members where project_id=p and user_id=auth.uid() and role='admin') $$;
create function public.task_member(t uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select coalesce((select is_member(project_id) from tasks where id=t),false) $$;
create function public.can_edit(t uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select coalesce((select is_admin(project_id) or (is_member(project_id) and assignee_id=auth.uid()) from tasks where id=t),false) $$;

do $$ declare t text; begin foreach t in array array['profiles','projects','project_members','tasks','task_events','comments','media_assets','detected_scenes','edit_versions','processing_jobs','renders','error_logs','notification_outbox','worker_heartbeats','command_keys'] loop execute format('alter table public.%I enable row level security',t); execute format('revoke all on public.%I from anon, authenticated',t); execute format('grant all on public.%I to service_role',t); end loop; end $$;
grant select on profiles,projects,project_members,tasks,task_events,comments,media_assets,detected_scenes,edit_versions,processing_jobs,renders,error_logs to authenticated;
create policy profiles_read on profiles for select to authenticated using(id=auth.uid() or exists(select 1 from project_members m where m.user_id=profiles.id and is_member(m.project_id)));
create policy projects_read on projects for select to authenticated using(is_member(id));
create policy members_read on project_members for select to authenticated using(is_member(project_id));
create policy tasks_read on tasks for select to authenticated using(is_member(project_id));
create policy events_read on task_events for select to authenticated using(task_member(task_id));
create policy comments_read on comments for select to authenticated using(task_member(task_id));
create policy assets_read on media_assets for select to authenticated using(task_member(task_id));
create policy scenes_read on detected_scenes for select to authenticated using(exists(select 1 from media_assets a where a.id=asset_id and task_member(a.task_id)));
create policy versions_read on edit_versions for select to authenticated using(task_member(task_id));
create policy jobs_read on processing_jobs for select to authenticated using(task_member(task_id));
create policy renders_read on renders for select to authenticated using(exists(select 1 from edit_versions v where v.id=version_id and task_member(v.task_id)));
create policy errors_read on error_logs for select to authenticated using(is_admin(project_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('sources','sources',false,52428800,array['video/mp4','video/quicktime','video/webm']),
 ('media','media',false,104857600,array['video/mp4','image/jpeg']);
create policy sources_insert on storage.objects for insert to authenticated with check(bucket_id='sources' and exists(select 1 from media_assets a where a.source_path=name and a.user_id=auth.uid() and a.status='uploading' and a.expires_at>now() and can_edit(a.task_id)));
create policy sources_read on storage.objects for select to authenticated using(bucket_id='sources' and exists(select 1 from media_assets a where a.source_path=name and task_member(a.task_id)));
create policy media_read on storage.objects for select to authenticated using(bucket_id='media' and (
 exists(select 1 from media_assets a where a.canonical_path=name and task_member(a.task_id)) or
 exists(select 1 from renders r join edit_versions v on v.id=r.version_id where r.path=name and task_member(v.task_id)) or
 exists(select 1 from detected_scenes s join media_assets a on a.id=s.asset_id where s.thumbnail_path=name and task_member(a.task_id))));

create function public.validate_timeline(p_timeline jsonb,p_asset uuid) returns void language plpgsql set search_path=public,pg_temp as $$
declare a media_assets; c jsonb; total integer:=0; ids uuid[]:='{}'; cid uuid; s integer; e integer;
begin
 select * into a from media_assets where id=p_asset and status='ready';
 if not found or jsonb_typeof(p_timeline)<>'array' or jsonb_array_length(p_timeline) not between 1 and 300 then raise exception 'INVALID_TIMELINE'; end if;
 for c in select * from jsonb_array_elements(p_timeline) loop
  if jsonb_typeof(c->'start') is distinct from 'number' or jsonb_typeof(c->'end') is distinct from 'number' or (c->>'start') !~ '^\d+$' or (c->>'end') !~ '^\d+$' then raise exception 'INVALID_TIMELINE'; end if;
  cid:=(c->>'id')::uuid; s:=(c->>'start')::integer; e:=(c->>'end')::integer;
  if cid is null or cid=any(ids) or (c->>'asset_id')::uuid is distinct from a.id or s<0 or e<=s or e>a.frames then raise exception 'INVALID_TIMELINE'; end if;
  ids:=array_append(ids,cid); total:=total+e-s;
 end loop;
 if total>900 then raise exception 'INVALID_TIMELINE'; end if;
end $$;

create function public.transition_task(p_task uuid,p_status text,p_user uuid) returns void language plpgsql set search_path=public,pg_temp as $$
declare t tasks;
begin
 select * into t from tasks where id=p_task for update;
 if t.status=p_status then return; end if;
 update tasks set status=p_status, completed_at=case when p_status='done' then now() else null end, completed_by=case when p_status='done' then t.assignee_id else null end where id=p_task;
 insert into task_events(task_id,user_id,from_status,to_status) values(p_task,p_user,t.status,p_status);
end $$;

-- One entrypoint for browser mutations. All writes and queue sends share a transaction.
create function public.amo_command(p_action text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare u uuid:=auth.uid(); pid uuid; tid uuid; vid uuid; aid uuid; target_user uuid; t tasks; a media_assets; v edit_versions; j processing_jobs; result jsonb; oldkey command_keys; idempotency_key text:=p->>'key'; next_no integer;
begin
 if u is null then raise exception 'UNAUTHORIZED'; end if;
 if octet_length(p::text)>100000 then raise exception 'INVALID_INPUT'; end if;
 if idempotency_key is not null then
  if length(idempotency_key) not between 8 and 128 then raise exception 'INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text||idempotency_key,0));
  select * into oldkey from command_keys where user_id=u and command_keys.key=idempotency_key;
  if found then
   if oldkey.action<>p_action or oldkey.target<>coalesce(p->>'version_id',p->>'asset_id','') then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return oldkey.result;
  end if;
 end if;
 if p_action='project.create' then
  insert into projects(name,created_by) values(trim(p->>'name'),u) returning id into pid;
  insert into project_members values(pid,u,'admin'); return jsonb_build_object('id',pid);
 elsif p_action='member.add' then
  pid:=(p->>'project_id')::uuid; if not is_admin(pid) then raise exception 'FORBIDDEN'; end if;
  select id into target_user from auth.users where lower(email)=lower(trim(p->>'email')) and email_confirmed_at is not null;
  if target_user is null then raise exception 'USER_NOT_FOUND'; end if;
  insert into project_members values(pid,target_user,'member') on conflict do nothing; return jsonb_build_object('id',target_user);
 elsif p_action='task.create' then
  pid:=(p->>'project_id')::uuid; if not is_admin(pid) then raise exception 'FORBIDDEN'; end if;
  insert into tasks(project_id,title,description,assignee_id,reviewer_id,created_by) values(pid,trim(p->>'title'),coalesce(p->>'description',''),nullif(p->>'assignee_id','')::uuid,nullif(p->>'reviewer_id','')::uuid,u) returning id into tid;
  return jsonb_build_object('id',tid);
 end if;
 tid:=nullif(p->>'task_id','')::uuid;
 if tid is null and p ? 'version_id' then select task_id into tid from edit_versions where id=(p->>'version_id')::uuid; end if;
 if tid is null and p ? 'asset_id' then select task_id into tid from media_assets where id=(p->>'asset_id')::uuid; end if;
 select * into t from tasks where id=tid for update;
 if not found or not is_member(t.project_id) then raise exception 'NOT_FOUND'; end if;
 if p_action='comment.add' then
  insert into comments(task_id,user_id,body) values(tid,u,trim(p->>'body')) returning to_jsonb(comments.*) into result;
 elsif p_action='task.update' then
  if not is_admin(t.project_id) then raise exception 'FORBIDDEN'; end if;
  update tasks set title=coalesce(nullif(trim(p->>'title'),''),title),description=coalesce(p->>'description',description),
   assignee_id=case when p ? 'assignee_id' then nullif(p->>'assignee_id','')::uuid else assignee_id end,
   reviewer_id=case when p ? 'reviewer_id' then nullif(p->>'reviewer_id','')::uuid else reviewer_id end where id=tid;
  result:=jsonb_build_object('id',tid);
 elsif p_action='task.status' then
  if t.status='done' then
   if not is_admin(t.project_id) or p->>'status'<>'in_progress' then raise exception 'INVALID_TRANSITION'; end if;
  elsif t.status='review' and p->>'status' in ('done','in_progress') then
   if not (is_admin(t.project_id) or coalesce(t.reviewer_id=u,false)) then raise exception 'FORBIDDEN'; end if;
   if p->>'status'='in_progress' then
    if length(trim(coalesce(p->>'comment','')))=0 then raise exception 'COMMENT_REQUIRED'; end if;
    insert into comments(task_id,user_id,body) values(tid,u,trim(p->>'comment'));
   end if;
  elsif t.status='todo' and p->>'status'='in_progress' then
   if not can_edit(tid) then raise exception 'FORBIDDEN'; end if;
  elsif t.status='in_progress' and p->>'status'='review' then
   if not can_edit(tid) then raise exception 'FORBIDDEN'; end if;
   if not exists(select 1 from renders where version_id=t.current_version_id) then raise exception 'RENDER_REQUIRED'; end if;
  else raise exception 'INVALID_TRANSITION'; end if;
  perform transition_task(tid,p->>'status',u); result:=jsonb_build_object('id',tid);
 else
  if not can_edit(tid) then raise exception 'FORBIDDEN'; end if;
  if t.status='done' then raise exception 'TASK_DONE'; end if;
  if p_action='upload.create' then
   if p->>'mime' not in ('video/mp4','video/quicktime','video/webm') then raise exception 'INVALID_FILE'; end if;
   update media_assets set status='failed' where task_id=tid and status='uploading' and expires_at<now();
   select * into a from media_assets where task_id=tid and status<>'failed';
   if found then raise exception 'SOURCE_EXISTS'; end if;
   aid:=gen_random_uuid();
   insert into media_assets(id,task_id,project_id,user_id,source_path,mime,bytes) values(aid,tid,t.project_id,u,t.project_id||'/'||tid||'/'||aid||'/source',p->>'mime',(p->>'bytes')::bigint) returning to_jsonb(media_assets.*) into result;
  elsif p_action='upload.cancel' then
   update media_assets set status='failed' where id=(p->>'asset_id')::uuid and task_id=tid and status='uploading';
   if not found then raise exception 'INVALID_UPLOAD'; end if;
   result:=jsonb_build_object('ok',true);
  elsif p_action='upload.complete' then
   select * into a from media_assets where id=(p->>'asset_id')::uuid and task_id=tid for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   select * into j from processing_jobs where asset_id=a.id and kind='analyze';
   if found then result:=to_jsonb(j); else
    if a.status<>'uploading' or a.expires_at<now() then raise exception 'INVALID_UPLOAD'; end if;
    if not exists(select 1 from storage.objects where bucket_id='sources' and name=a.source_path and (metadata->>'size')::bigint=a.bytes) then raise exception 'UPLOAD_INCOMPLETE'; end if;
    update media_assets set status='queued' where id=a.id;
    insert into processing_jobs(task_id,asset_id,user_id,kind) values(tid,a.id,u,'analyze') returning * into j;
    perform pgmq.send('video',jsonb_build_object('job_id',j.id));
    if t.status='todo' then perform transition_task(tid,'in_progress',u); end if;
    result:=to_jsonb(j);
   end if;
  elsif p_action='version.copy' then
   select * into v from edit_versions where id=(p->>'version_id')::uuid and task_id=tid;
   if not found then raise exception 'NOT_FOUND'; end if;
   select coalesce(max(number),0)+1 into next_no from edit_versions where task_id=tid;
   insert into edit_versions(task_id,asset_id,number,timeline,created_by) values(tid,v.asset_id,next_no,v.timeline,u) returning id into vid;
   update tasks set current_version_id=vid where id=tid;
   if t.status='review' then perform transition_task(tid,'in_progress',u); end if;
   result:=jsonb_build_object('id',vid);
  elsif p_action in ('version.save','render.start','render.retry') then
   select * into v from edit_versions where id=(p->>'version_id')::uuid and task_id=tid for update;
   if not found then raise exception 'NOT_FOUND'; end if;
   if p_action='version.save' then
    if v.locked_at is not null then raise exception 'VERSION_LOCKED'; end if;
    if v.revision is distinct from (p->>'revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
    perform validate_timeline(p->'timeline',v.asset_id);
    update edit_versions set timeline=p->'timeline',revision=revision+1 where id=v.id returning to_jsonb(edit_versions.*) into result;
   else
    select * into j from processing_jobs where version_id=v.id for update;
    if found then
     if j.status='failed' and p_action='render.retry' then
      update processing_jobs set status='queued',stage='queued',attempt=0,lease_until=null,error_code=null,progress=0,finished_at=null where id=j.id returning * into j;
      perform pgmq.send('video',jsonb_build_object('job_id',j.id));
     end if;
     result:=to_jsonb(j);
    else
     if v.revision is distinct from (p->>'revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
     perform validate_timeline(v.timeline,v.asset_id);
     update edit_versions set locked_at=now() where id=v.id;
     insert into processing_jobs(task_id,asset_id,version_id,user_id,kind,snapshot) values(tid,v.asset_id,v.id,u,'render',v.timeline) returning * into j;
     perform pgmq.send('video',jsonb_build_object('job_id',j.id)); result:=to_jsonb(j);
    end if;
   end if;
  else raise exception 'INVALID_ACTION'; end if;
 end if;
 if idempotency_key is not null then insert into command_keys values(u,idempotency_key,p_action,coalesce(p->>'version_id',p->>'asset_id',''),result); end if;
 return result;
end $$;

-- Service-only worker functions. Lease and attempt are a fencing token.
create function public.worker_claim(p_worker text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m record; j processing_jobs;
begin
 insert into worker_heartbeats values(p_worker,now()) on conflict(id) do update set updated_at=now();
 select * into m from pgmq.read('video',120,1);
 if not found then return null; end if;
 select * into j from processing_jobs where id=(m.message->>'job_id')::uuid for update;
 if not found or j.status in ('succeeded','failed') then perform pgmq.delete('video',m.msg_id); return null; end if;
 if j.status='running' and j.lease_until>now() then return null; end if;
 if j.attempt>=3 then
  update processing_jobs set status='failed',stage='failed',error_code='WORKER_RESTART_LIMIT',finished_at=now() where id=j.id;
  if j.kind='analyze' then update media_assets set status='failed' where id=j.asset_id; end if;
  perform log_error(j.task_id,j.id,j.user_id,'worker','WORKER_RESTART_LIMIT','Обробку перервано тричі',null,true,null);
  perform pgmq.delete('video',m.msg_id); return null;
 end if;
 update processing_jobs set status='running',stage='download',attempt=attempt+1,msg_id=m.msg_id,lease_until=now()+interval '120 seconds',started_at=now(),progress=0 where id=j.id returning * into j;
 if j.kind='analyze' then update media_assets set status='processing' where id=j.asset_id; end if;
 return to_jsonb(j);
end $$;
create function public.worker_beat(p_job uuid,p_attempt integer,p_msg bigint,p_progress integer,p_stage text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update processing_jobs set lease_until=now()+interval '120 seconds',progress=greatest(0,least(99,p_progress)),stage=p_stage where id=p_job and attempt=p_attempt and msg_id=p_msg and status='running' and lease_until>now();
 if not found then return false; end if;
 perform pgmq.set_vt('video',p_msg,120); return true;
end $$;
create function public.log_error(p_task uuid,p_job uuid,p_user uuid,p_stage text,p_type text,p_message text,p_stack text,p_critical boolean,p_request uuid) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare eid uuid; pid uuid;
begin
 select project_id into pid from tasks where id=p_task;
 insert into error_logs(project_id,task_id,job_id,user_id,stage,type,message,stack_trace,critical,request_id) values(pid,p_task,p_job,p_user,left(p_stage,80),left(p_type,100),left(p_message,2000),left(p_stack,12000),p_critical,p_request) returning id into eid;
 if p_critical then insert into notification_outbox(error_id) values(eid); end if;
 return eid;
end $$;
create function public.worker_fail(p_job uuid,p_attempt integer,p_msg bigint,p_code text,p_message text,p_stack text,p_retry boolean) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j processing_jobs;
begin
 select * into j from processing_jobs where id=p_job for update;
 if j.status<>'running' or j.attempt<>p_attempt or j.msg_id<>p_msg or j.lease_until<=now() then return false; end if;
 perform log_error(j.task_id,j.id,j.user_id,j.stage,p_code,p_message,p_stack,true,null);
 if p_retry and j.attempt<3 then
  update processing_jobs set status='queued',lease_until=null,error_code=p_code where id=j.id;
  perform pgmq.set_vt('video',p_msg,case when j.attempt=1 then 10 else 30 end);
 else
  update processing_jobs set status='failed',stage='failed',finished_at=now(),error_code=p_code,lease_until=null where id=j.id;
  if j.kind='analyze' then update media_assets set status='failed' where id=j.asset_id; end if;
  perform pgmq.delete('video',p_msg);
 end if; return true;
end $$;
create function public.worker_complete(p_job uuid,p_attempt integer,p_msg bigint,p_result jsonb) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j processing_jobs; t tasks; c jsonb; vid uuid; next_no integer;
begin
 -- Match command lock order: task, then job; prevents render/complete deadlocks.
 select task_id into vid from processing_jobs where id=p_job;
 select * into t from tasks where id=vid for update;
 select * into j from processing_jobs where id=p_job for update;
 if j.status<>'running' or j.attempt<>p_attempt or j.msg_id<>p_msg or j.lease_until<=now() then return false; end if;
 if j.kind='analyze' then
  update media_assets set status='ready',canonical_path=p_result->>'path',duration=(p_result->>'duration')::float,frames=(p_result->>'frames')::integer,has_audio=(p_result->>'has_audio')::boolean where id=j.asset_id;
  perform validate_timeline(p_result->'timeline',j.asset_id);
  for c in select * from jsonb_array_elements(p_result->'scenes') loop
   insert into detected_scenes(asset_id,start_frame,end_frame,thumbnail_path) values(j.asset_id,(c->>'start')::integer,(c->>'end')::integer,c->>'path');
  end loop;
  select coalesce(max(number),0)+1 into next_no from edit_versions where task_id=j.task_id;
  insert into edit_versions(task_id,asset_id,number,timeline,created_by) values(j.task_id,j.asset_id,next_no,p_result->'timeline',j.user_id) returning id into vid;
  update tasks set current_version_id=vid where id=j.task_id;
 else
  insert into renders(version_id,job_id,path,duration) values(j.version_id,j.id,p_result->>'path',(p_result->>'duration')::float);
  if t.current_version_id=j.version_id and t.status='in_progress' then perform transition_task(j.task_id,'review',j.user_id); end if;
 end if;
 update processing_jobs set status='succeeded',stage='complete',progress=100,finished_at=now(),lease_until=null,render_ms=(p_result->>'render_ms')::integer where id=j.id;
 perform pgmq.delete('video',p_msg); return true;
end $$;
create function public.notification_claim() returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare n notification_outbox; e error_logs; token uuid:=gen_random_uuid();
begin
 select * into n from notification_outbox where sent_at is null and next_at<=now() and (lease_until is null or lease_until<now()) order by next_at for update skip locked limit 1;
 if not found then return null; end if;
 update notification_outbox set lease_token=token,lease_until=now()+interval '30 seconds',attempts=attempts+1 where id=n.id;
 select * into e from error_logs where id=n.error_id;
 return jsonb_build_object('id',n.id,'token',token,'attempt',n.attempts+1,'error_id',e.id,'stage',e.stage,'type',e.type,'task_id',e.task_id);
end $$;
create function public.notification_finish(p_id uuid,p_token uuid,p_error text default null) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin update notification_outbox set sent_at=case when p_error is null then now() else null end,next_at=now()+make_interval(secs=>least(3600,10*power(2,least(attempts,8)))::integer),lease_until=null,last_error=left(p_error,500) where id=p_id and lease_token=p_token; end $$;

-- Explicit allowlist; default PUBLIC execute privileges must never expose worker operations.
do $$ declare f record; begin for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_profile','is_member','is_admin','task_member','can_edit','validate_timeline','transition_task','amo_command','worker_claim','worker_beat','log_error','worker_fail','worker_complete','notification_claim','notification_finish') loop execute format('revoke all on function %s from public, anon, authenticated',f.signature); execute format('grant execute on function %s to service_role',f.signature); end loop; end $$;
grant execute on function is_member(uuid),is_admin(uuid),task_member(uuid),can_edit(uuid),amo_command(text,jsonb) to authenticated;
