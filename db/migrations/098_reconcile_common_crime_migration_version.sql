-- ============================================================
-- [gpt] 迁移 098：兼容并行开发期间共同犯罪试点误占 019 的历史现场
--
-- 仅命中已知文件名和已知 checksum 时迁移账本元数据；业务关系本身保持不变。
-- 正常新环境没有这条临时 019 记录，因此本迁移为空操作。
-- ============================================================

do $reconcile_common_crime_version$
declare
  accidental_checksum text;
begin
  select checksum_sha256
    into accidental_checksum
  from schema_migrations
  where version = '019'
    and filename = '019_common_crime_contrast_graph.sql';

  if found then
    if accidental_checksum <> '35eee94b01d4c9c4ad21b75d26ba60fc8ce7905d472b2039d044a7af23c60414' then
      raise exception 'unexpected checksum for accidental 019 common-crime migration: %', accidental_checksum;
    end if;

    if exists (select 1 from schema_migrations where version = '099') then
      raise exception 'cannot reconcile accidental 019: version 099 is already registered';
    end if;

    update schema_migrations
    set version = '099',
        filename = '099_common_crime_contrast_graph.sql',
        checksum_sha256 = 'bca6f7305a23b86bece3970fbce135f189d0ba967c5d6177b7f3ff483b34d76e',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'bytes', 2519,
          'reconciled_from', '019_common_crime_contrast_graph.sql'
        ),
        last_verified_at = now()
    where version = '019'
      and filename = '019_common_crime_contrast_graph.sql';
  end if;
end
$reconcile_common_crime_version$;
