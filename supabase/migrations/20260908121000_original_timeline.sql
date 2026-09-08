-- The source timeline is a separate baseline, including for existing tasks.
insert into public.edit_versions(task_id,asset_id,number,timeline,created_by)
select a.task_id,a.id,0,coalesce(
 (select jsonb_agg(jsonb_build_object('id',s.id,'asset_id',a.id,'start',s.start_frame,'end',s.end_frame) order by s.start_frame)
  from public.detected_scenes s where s.asset_id=a.id),
 jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'asset_id',a.id,'start',0,'end',a.frames))),a.user_id
from public.media_assets a where a.status='ready' and a.frames>0
on conflict(task_id,number) do nothing;

create function public.keep_original_timeline() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.number=1 then
  insert into edit_versions(task_id,asset_id,number,timeline,created_by)
   values(new.task_id,new.asset_id,0,new.timeline,new.created_by)
   on conflict(task_id,number) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.keep_original_timeline() from public,anon,authenticated;
create trigger keep_original_timeline after insert on public.edit_versions
for each row execute function public.keep_original_timeline();
