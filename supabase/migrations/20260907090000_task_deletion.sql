alter table public.tasks add column deleted_at timestamptz;
alter table public.tasks add column deleted_by uuid references public.profiles;
alter table public.task_events add column event_type text not null default 'status'
  check (event_type in ('status','deleted','restored'));
create index deleted_tasks_project on public.tasks(project_id,deleted_at) where deleted_at is not null;

create or replace function public.task_member(t uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select is_member(project_id) and (deleted_at is null or is_admin(project_id)) from tasks where id=t),false)
$$;
create or replace function public.can_edit(t uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select deleted_at is null and (is_admin(project_id) or (is_member(project_id) and assignee_id=auth.uid())) from tasks where id=t),false)
$$;
alter policy tasks_read on public.tasks using(is_member(project_id) and (deleted_at is null or is_admin(project_id)));

-- Keep existing commands behind a single checked entry point. The task row lock
-- serializes deletion against edits, queue creation and worker completion.
alter function public.amo_command(text,jsonb) rename to amo_command_base;
revoke all on function public.amo_command_base(text,jsonb) from public,anon,authenticated,service_role;
create function public.amo_command(p_action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare tid uuid; t tasks; u uuid:=auth.uid();
begin
 if u is null then raise exception 'UNAUTHORIZED'; end if;
 if octet_length(p::text)>100000 then raise exception 'INVALID_INPUT'; end if;
 tid:=nullif(p->>'task_id','')::uuid;
 if tid is null and p ? 'version_id' then select task_id into tid from edit_versions where id=(p->>'version_id')::uuid; end if;
 if tid is null and p ? 'asset_id' then select task_id into tid from media_assets where id=(p->>'asset_id')::uuid; end if;
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
 return amo_command_base(p_action,p);
end $$;
revoke all on function public.amo_command(text,jsonb) from public,anon;
grant execute on function public.amo_command(text,jsonb) to authenticated,service_role;
