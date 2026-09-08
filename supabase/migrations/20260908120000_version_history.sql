-- Keep the initial edit and every rendered snapshot recoverable.
alter table public.edit_versions add column deleted_at timestamptz;
alter function public.amo_command(text,jsonb) rename to amo_command_before_history;
revoke all on function public.amo_command_before_history(text,jsonb) from public,anon,authenticated;

create function public.amo_command(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v edit_versions; t tasks; pr projects; next_id uuid; next_no integer; result jsonb;
begin
 if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
 if octet_length(p::text)>100000 then raise exception 'INVALID_INPUT'; end if;
 if p_action in ('version.save','version.copy','version.delete','render.start','render.retry') then
  select * into v from edit_versions where id=(p->>'version_id')::uuid;
  select project_id into next_id from tasks where id=v.task_id;
  select * into pr from projects where id=next_id for update;
  select * into t from tasks where id=v.task_id for update;
  select * into v from edit_versions where id=(p->>'version_id')::uuid for update;
  if v.id is null or v.deleted_at is not null or not is_member(t.project_id) then raise exception 'NOT_FOUND'; end if;
  if pr.deleted_at is not null then raise exception 'PROJECT_DELETED'; end if;
  if t.deleted_at is not null then raise exception 'TASK_DELETED'; end if;
  if not can_edit(t.id) then raise exception 'FORBIDDEN'; end if;
  if p_action='version.delete' then
   if t.status<>'in_progress' or v.number=0 or exists(select 1 from processing_jobs where version_id=v.id and status in ('queued','running')) then raise exception 'VERSION_LOCKED'; end if;
   update edit_versions set deleted_at=now() where id=v.id;
   select id into next_id from edit_versions where task_id=t.id and deleted_at is null
    order by (number<v.number) desc,number desc limit 1;
   if t.current_version_id=v.id then update tasks set current_version_id=next_id where id=t.id; end if;
   return jsonb_build_object('id',v.id,'selected_version_id',next_id);
  end if;
  if p_action='version.save' then
   if t.status<>'in_progress' or exists(select 1 from processing_jobs where version_id=v.id and status in ('queued','running')) then raise exception 'VERSION_LOCKED'; end if;
   if v.revision is distinct from (p->>'revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
   perform validate_timeline(p->'timeline',v.asset_id);
   if v.timeline is distinct from p->'timeline' and (v.number=0 or exists(select 1 from processing_jobs where version_id=v.id)) then
    select coalesce(max(number),0)+1 into next_no from edit_versions where task_id=t.id;
    insert into edit_versions(task_id,asset_id,number,timeline,created_by)
     values(t.id,v.asset_id,next_no,p->'timeline',auth.uid()) returning to_jsonb(edit_versions.*) into result;
    update tasks set current_version_id=(result->>'id')::uuid where id=t.id;
    return result;
   end if;
  end if;
 end if;
 return amo_command_before_history(p_action,p);
end $$;
revoke all on function public.amo_command(text,jsonb) from public,anon;
grant execute on function public.amo_command(text,jsonb) to authenticated,service_role;
