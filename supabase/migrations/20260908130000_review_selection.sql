-- Review is an explicit action for a selected rendered version.
alter table public.tasks add column review_version_id uuid;
alter table public.tasks add constraint review_version_belongs_to_task
 foreign key(review_version_id,id) references public.edit_versions(id,task_id);
update public.tasks set review_version_id=current_version_id
where status in ('review','done');

alter function public.amo_command(text,jsonb) rename to amo_command_before_review_selection;
revoke all on function public.amo_command_before_review_selection(text,jsonb)
 from public,anon,authenticated;

create function public.amo_command(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare t tasks; v edit_versions; result jsonb; target_status text:=p->>'status';
begin
 if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
 if octet_length(p::text)>100000 then raise exception 'INVALID_INPUT'; end if;
 if p_action='task.status' then
  select * into t from tasks where id=(p->>'task_id')::uuid for update;
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  if target_status='review' then
   if nullif(p->>'version_id','') is null then raise exception 'INVALID_INPUT'; end if;
   select * into v from edit_versions
    where id=(p->>'version_id')::uuid and task_id=t.id and deleted_at is null;
   if v.id is null then raise exception 'NOT_FOUND'; end if;
   if t.status<>'in_progress' then raise exception 'INVALID_TRANSITION'; end if;
   if not can_edit(t.id) then raise exception 'FORBIDDEN'; end if;
   if exists(select 1 from processing_jobs where task_id=t.id and status in ('queued','running')) then raise exception 'VERSION_LOCKED'; end if;
   if not exists(select 1 from renders where version_id=v.id and version_revision=v.revision) then raise exception 'RENDER_REQUIRED'; end if;
   update tasks set current_version_id=v.id,review_version_id=v.id where id=t.id;
  elsif target_status='done' then
   if t.review_version_id is null then raise exception 'RENDER_REQUIRED'; end if;
   update tasks set current_version_id=review_version_id where id=t.id;
  end if;
  result:=amo_command_before_review_selection(p_action,p);
  if target_status='in_progress' and t.status in ('review','done') then
   update tasks set review_version_id=null where id=t.id;
  end if;
  return result;
 end if;
 return amo_command_before_review_selection(p_action,p);
end $$;
revoke all on function public.amo_command(text,jsonb) from public,anon;
grant execute on function public.amo_command(text,jsonb) to authenticated,service_role;

create function public.version_visible(p_version uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select task_member(v.task_id) and v.deleted_at is null and (
  t.status in ('todo','in_progress') or
  (t.status='review' and (v.number=0 or v.id=t.review_version_id)) or
  (t.status='done' and v.id=t.review_version_id)
 ) from edit_versions v join tasks t on t.id=v.task_id where v.id=p_version),false)
$$;
revoke all on function public.version_visible(uuid) from public,anon;
grant execute on function public.version_visible(uuid) to authenticated,service_role;

drop policy versions_read on public.edit_versions;
create policy versions_read on public.edit_versions for select to authenticated
 using(version_visible(id));
drop policy jobs_read on public.processing_jobs;
create policy jobs_read on public.processing_jobs for select to authenticated
 using(task_member(task_id) and (version_id is null or version_visible(version_id)));
drop policy renders_read on public.renders;
create policy renders_read on public.renders for select to authenticated
 using(version_visible(version_id));
drop policy media_read on storage.objects;
create policy media_read on storage.objects for select to authenticated using(bucket_id='media' and (
 exists(select 1 from media_assets a where a.canonical_path=name and task_member(a.task_id)) or
 exists(select 1 from renders r where r.path=name and version_visible(r.version_id)) or
 exists(select 1 from detected_scenes s join media_assets a on a.id=s.asset_id where s.thumbnail_path=name and task_member(a.task_id))));

create or replace function public.worker_complete(p_job uuid,p_attempt integer,p_msg bigint,p_result jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare j processing_jobs; c jsonb; vid uuid; next_no integer;
begin
 select task_id into vid from processing_jobs where id=p_job;
 perform 1 from tasks where id=vid for update;
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
 end if;
 update processing_jobs set status='succeeded',stage='complete',progress=100,finished_at=now(),lease_until=null,render_ms=(p_result->>'render_ms')::integer where id=j.id;
 perform pgmq.delete('video',p_msg); return true;
end $$;
revoke all on function public.worker_complete(uuid,integer,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.worker_complete(uuid,integer,bigint,jsonb) to service_role;
