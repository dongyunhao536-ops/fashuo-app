// [gpt] 2026-08-10：content_mirror 单路径替换失败时恢复旧行，避免 delete 成功、insert 失败后内容消失。
export async function replaceMirrorRows({
  path,
  readPrevious,
  deleteExisting,
  insertNext,
  restorePrevious,
}) {
  const previousResponse = await readPrevious();
  if (previousResponse?.error) throw new Error(`snapshot: ${previousResponse.error.message ?? previousResponse.error}`);
  const previous = previousResponse?.data ?? [];

  const deleteResponse = await deleteExisting();
  if (deleteResponse?.error) throw new Error(`delete: ${deleteResponse.error.message ?? deleteResponse.error}`);

  const insertResponse = await insertNext();
  if (!insertResponse?.error) return { replaced: true, restored: false, previousRows: previous.length };

  if (previous.length) {
    const restoreResponse = await restorePrevious(previous);
    if (restoreResponse?.error) {
      throw new Error(
        `insert: ${insertResponse.error.message ?? insertResponse.error}；restore failed: ${restoreResponse.error.message ?? restoreResponse.error}；path=${path}`,
      );
    }
  }
  throw new Error(`insert: ${insertResponse.error.message ?? insertResponse.error}${previous.length ? "（旧内容已恢复）" : ""}`);
}
