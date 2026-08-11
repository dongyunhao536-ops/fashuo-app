-- ============================================================
-- [gpt] 迁移 017：数据库级错题事件销账门槛
--
-- 所有入口只要把 study_error open -> absorbed，都必须由事实证据证明：
-- 1. 不是当日新错；2. 最近失败后至少两条 clean L3+ application pass；
-- 3. 至少两个结构化验证轴；4. 至少一次冷检；5. 每条带原答/依据 note。
-- ============================================================

create or replace function enforce_study_error_absorption_gate()
returns trigger
language plpgsql
as $$
declare
  v_topic_id bigint;
  v_pass_count integer := 0;
  v_axis_count integer := 0;
  v_cold_count integer := 0;
  v_beijing_date date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if new.status = 'absorbed' and old.status is distinct from 'absorbed' then
    if old.log_date >= v_beijing_date then
      raise exception using errcode = '23514', message = format('错题 #%s 当日新错不得销账', old.id);
    end if;

    select topic_id into v_topic_id
    from study_error_topic
    where study_error_id = old.id and role = 'primary'
    limit 1;
    if v_topic_id is null then
      raise exception using errcode = '23514', message = format('错题 #%s 尚未关联 primary 弱项主题，不能销账', old.id);
    end if;

    with latest_failure as (
      select review_date, id
      from error_review
      where study_error_id = old.id
        and topic_id = v_topic_id
        and result in ('partial', 'fail')
        and review_date <= v_beijing_date
      order by review_date desc, id desc
      limit 1
    ), eligible_pass as (
      select r.*
      from error_review r
      where r.study_error_id = old.id
        and r.topic_id = v_topic_id
        and r.review_date <= v_beijing_date
        and r.result = 'pass'
        and r.dimension = 'application'
        and r.prompt_integrity = 'clean'
        and r.transfer_level >= 3
        and r.probe_axis is not null
        and r.probe_axis <> 'invalid'
        and nullif(btrim(r.angle), '') is not null
        and nullif(btrim(r.evidence_anchor), '') is not null
        and nullif(btrim(r.note), '') is not null
        and not exists (
          select 1 from latest_failure f
          where (r.review_date, r.id) <= (f.review_date, f.id)
        )
    )
    select count(*)::integer,
           count(distinct probe_axis)::integer,
           count(*) filter (where cold is true)::integer
      into v_pass_count, v_axis_count, v_cold_count
    from eligible_pass;

    if v_pass_count < 2 or v_axis_count < 2 or v_cold_count < 1 then
      raise exception using errcode = '23514', message = format(
        '错题 #%s 销账证据门槛未满足：pass %s/2，验证轴 %s/2，冷检 %s/1',
        old.id, v_pass_count, v_axis_count, v_cold_count
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_study_error_absorption_gate on study_error;
create trigger trg_study_error_absorption_gate
before update of status on study_error
for each row execute function enforce_study_error_absorption_gate();

notify pgrst, 'reload schema';
