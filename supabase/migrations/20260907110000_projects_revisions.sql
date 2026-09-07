-- Projects are recoverable; child task deletion markers remain independent.
alter table public.projects add column deleted_at timestamptz;
alter table public.projects add column deleted_by uuid references public.profiles;
create or replace function public.is_member(p uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from project_members m join projects pr on pr.id=m.project_id where m.project_id=p and m.user_id=auth.uid() and pr.deleted_at is null)
$$;
alter policy projects_read on public.projects using(is_member(id) or is_admin(id));
create or replace function public.can_edit(t uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select deleted_at is null and is_member(project_id) and (is_admin(project_id) or assignee_id=auth.uid()) from tasks where id=t),false)
$$;
-- Historical MP4s reference the exact saved revision that produced them.
alter table public.processing_jobs add column version_revision integer;
update public.processing_jobs j set version_revision=v.revision from public.edit_versions v where j.version_id=v.id;
alter table public.processing_jobs add constraint render_revision_required check(kind<>'render' or version_revision>0 and version_revision is not null);
drop index public.one_render_job;
create unique index one_render_revision_job on public.processing_jobs(version_id,version_revision) where kind='render';
alter table public.renders add column version_revision integer;
update public.renders r set version_revision=j.version_revision from public.processing_jobs j where r.job_id=j.id;
alter table public.renders alter column version_revision set not null;
alter table public.renders drop constraint renders_version_id_key;
alter table public.renders add constraint one_render_revision unique(version_id,version_revision);

create or replace function public.amo_command_base(p_action text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
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
   if not exists(select 1 from renders r join edit_versions ev on ev.id=r.version_id and ev.revision=r.version_revision where ev.id=t.current_version_id) then raise exception 'RENDER_REQUIRED'; end if;
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
    if exists(select 1 from processing_jobs where version_id=v.id and status in ('queued','running')) then raise exception 'VERSION_LOCKED'; end if;
    if v.revision is distinct from (p->>'revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
    perform validate_timeline(p->'timeline',v.asset_id);
    update edit_versions set timeline=p->'timeline',revision=revision+case when timeline is distinct from p->'timeline' then 1 else 0 end,locked_at=null where id=v.id returning to_jsonb(edit_versions.*) into result;
   else
    select * into j from processing_jobs where version_id=v.id and version_revision=v.revision for update;
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
     insert into processing_jobs(task_id,asset_id,version_id,version_revision,user_id,kind,snapshot) values(tid,v.asset_id,v.id,v.revision,u,'render',v.timeline) returning * into j;
     perform pgmq.send('video',jsonb_build_object('job_id',j.id)); result:=to_jsonb(j);
    end if;
   end if;
  else raise exception 'INVALID_ACTION'; end if;
 end if;
 if idempotency_key is not null then insert into command_keys values(u,idempotency_key,p_action,coalesce(p->>'version_id',p->>'asset_id',''),result); end if;
 return result;
end $$;


create or replace function public.amo_command(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare pid uuid; pr projects; v edit_versions; tid uuid; t tasks; u uuid:=auth.uid();
begin
 if u is null then raise exception 'UNAUTHORIZED'; end if;
 if octet_length(p::text)>100000 then raise exception 'INVALID_INPUT'; end if;
 tid:=nullif(p->>'task_id','')::uuid;
 if tid is null and p ? 'version_id' then select task_id into tid from edit_versions where id=(p->>'version_id')::uuid; end if;
 if tid is null and p ? 'asset_id' then select task_id into tid from media_assets where id=(p->>'asset_id')::uuid; end if;
 if p_action in ('project.delete','project.restore','member.add','task.create') then
  tid:=null; pid:=nullif(p->>'project_id','')::uuid;
 elsif tid is not null then select project_id into pid from tasks where id=tid;
 else pid:=nullif(p->>'project_id','')::uuid; end if;
 if pid is not null then
  select * into pr from projects where id=pid for update;
  if not found or not (is_member(pid) or is_admin(pid)) then raise exception 'NOT_FOUND'; end if;
 end if;
 if p_action in ('project.delete','project.restore') then
  if pr.id is null then raise exception 'NOT_FOUND'; end if;
  if not is_admin(pid) then raise exception 'FORBIDDEN'; end if;
  if p_action='project.delete' then
   update projects set deleted_at=coalesce(deleted_at,now()),deleted_by=coalesce(deleted_by,u) where id=pid;
  else update projects set deleted_at=null,deleted_by=null where id=pid; end if;
  return jsonb_build_object('id',pid);
 end if;
 if pr.deleted_at is not null then raise exception 'PROJECT_DELETED'; end if;
 if tid is not null then
  select * into t from tasks where id=tid for update;
  if not found or not is_member(t.project_id) then raise exception 'NOT_FOUND'; end if;
 end if;
 if p_action in ('task.delete','task.restore') then
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  if not is_admin(t.project_id) then raise exception 'FORBIDDEN'; end if;
  if p_action='task.delete' and t.deleted_at is null then
   update tasks set deleted_at=now(),deleted_by=u where id=tid;
   insert into task_events(task_id,user_id,from_status,to_status,event_type) values(tid,u,t.status,t.status,'deleted');
  elsif p_action='task.restore' and t.deleted_at is not null then
   update tasks set deleted_at=null,deleted_by=null where id=tid;
   insert into task_events(task_id,user_id,from_status,to_status,event_type) values(tid,u,t.status,t.status,'restored');
  end if;
  return jsonb_build_object('id',tid);
 end if;
 if t.deleted_at is not null then raise exception 'TASK_DELETED'; end if;
 if p_action in ('version.save','version.copy','render.start','render.retry') then
  if not can_edit(tid) then raise exception 'FORBIDDEN'; end if;
  select * into v from edit_versions where id=(p->>'version_id')::uuid and task_id=tid;
  if not found then raise exception 'NOT_FOUND'; end if;
  if p_action in ('version.save','version.copy') and t.status<>'in_progress' then raise exception 'VERSION_LOCKED'; end if;
  if p_action in ('render.start','render.retry') then
   if p ? 'revision' and v.revision is distinct from (p->>'revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
   if t.status<>'in_progress' and not exists(select 1 from processing_jobs where version_id=v.id and version_revision=v.revision and status in ('queued','running','succeeded')) then raise exception 'VERSION_LOCKED'; end if;
   -- Scope command deduplication to this exact revision, including older clients.
   if length(p->>'key') not between 8 and 128 or p->>'key' is null then raise exception 'INVALID_INPUT'; end if;
   p:=p||jsonb_build_object('key',md5(p->>'key')||':'||v.id::text||':'||v.revision::text);
  end if;
 end if;
 if p_action='task.status' and p->>'status' in ('review','done') then
  if exists(select 1 from processing_jobs where task_id=tid and status in ('queued','running')) then raise exception 'VERSION_LOCKED'; end if;
  if not exists(select 1 from renders r join edit_versions ev on ev.id=r.version_id and ev.revision=r.version_revision where ev.id=t.current_version_id) then raise exception 'RENDER_REQUIRED'; end if;
 end if;
 return amo_command_base(p_action,p);
end $$;
revoke all on function public.amo_command(text,jsonb) from public,anon;
grant execute on function public.amo_command(text,jsonb) to authenticated,service_role;

create or replace function public.worker_complete(p_job uuid,p_attempt integer,p_msg bigint,p_result jsonb) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
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
  insert into renders(version_id,version_revision,job_id,path,duration) values(j.version_id,j.version_revision,j.id,p_result->>'path',(p_result->>'duration')::float);
  if t.current_version_id=j.version_id and t.status='in_progress' and exists(select 1 from edit_versions where id=j.version_id and revision=j.version_revision) and not exists(select 1 from processing_jobs where task_id=j.task_id and id<>j.id and status in ('queued','running')) then perform transition_task(j.task_id,'review',j.user_id); end if;
 end if;
 update processing_jobs set status='succeeded',stage='complete',progress=100,finished_at=now(),lease_until=null,render_ms=(p_result->>'render_ms')::integer where id=j.id;
 perform pgmq.delete('video',p_msg); return true;
end $$;
