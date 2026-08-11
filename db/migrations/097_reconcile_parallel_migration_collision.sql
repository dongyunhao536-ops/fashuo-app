-- ============================================================
-- [gpt] 迁移 097：收口并行开发期间 021/022 的迁移编号碰撞
--
-- 只迁移两条已知 checksum 的临时账本记录到保留段 098/099；
-- 不删除业务表或业务数据。正常新环境没有临时记录，因此为空操作。
-- ============================================================

do $reconcile_parallel_versions$
declare
  repair_checksum text;
  graph_checksum text;
begin
  select checksum_sha256
    into repair_checksum
  from schema_migrations
  where version = '021'
    and filename = '021_reconcile_common_crime_migration_version.sql';

  if found then
    if repair_checksum <> '23dc09cb4da3387ecb93ef0298a484cd5d393bc19b29c56c7fd833c0e4e24c16' then
      raise exception 'unexpected checksum for temporary 021 reconciliation migration: %', repair_checksum;
    end if;
    if exists (select 1 from schema_migrations where version = '098') then
      raise exception 'cannot move temporary 021 migration: version 098 is already registered';
    end if;

    update schema_migrations
    set version = '098',
        filename = '098_reconcile_common_crime_migration_version.sql',
        checksum_sha256 = '77745e8edb2df95d5f293dacb46161a8766887be4644f95a49b4f2b7db52e408',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'bytes', 1623,
          'reconciled_from', '021_reconcile_common_crime_migration_version.sql'
        ),
        last_verified_at = now()
    where version = '021'
      and filename = '021_reconcile_common_crime_migration_version.sql';
  end if;

  select checksum_sha256
    into graph_checksum
  from schema_migrations
  where version = '022'
    and filename = '022_common_crime_contrast_graph.sql';

  if found then
    if graph_checksum <> '4050d4ac609e62ebd5ca3c2aac27bce03a32115f380497d31061079a4139d8f1' then
      raise exception 'unexpected checksum for temporary 022 common-crime migration: %', graph_checksum;
    end if;
    if exists (select 1 from schema_migrations where version = '099') then
      raise exception 'cannot move temporary 022 migration: version 099 is already registered';
    end if;

    update schema_migrations
    set version = '099',
        filename = '099_common_crime_contrast_graph.sql',
        checksum_sha256 = 'bca6f7305a23b86bece3970fbce135f189d0ba967c5d6177b7f3ff483b34d76e',
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'bytes', 2519,
          'reconciled_from', '022_common_crime_contrast_graph.sql'
        ),
        last_verified_at = now()
    where version = '022'
      and filename = '022_common_crime_contrast_graph.sql';
  end if;
end
$reconcile_parallel_versions$;
