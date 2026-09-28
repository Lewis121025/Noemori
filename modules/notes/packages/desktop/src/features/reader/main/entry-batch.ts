import type { RenameOutcome, VaultEntry } from "../shared/api";
import type { EntryBatchControl } from "./entry-batch-control";
import {
  planEntryBatch,
  independentEntryPaths,
  type EntryBatchRequest,
  type EntryBatchResult,
  type EntryBatchIssue,
  type EntryMutation,
} from "../shared/entry-batch";

/** 内核确认的已提交前缀；异常、停止和派生警告都不能改变该边界。 */
export type EntryBatchExecution = {
  completed: number;
  issue: EntryBatchIssue | null;
  warning: string | null;
};

/**
 * 执行器负责全部预检、逐项事务和索引收尾；回调以 0 开始并递增报告提交数。
 * 返回 false 或回调抛错时停止后续项；已有提交必须通过最终结果返回，不能直接抛出。
 */
export type EntryBatchRunner = (
  changes: EntryMutation[],
  progress: (completed: number) => boolean,
) => EntryBatchExecution;

/**
 * 将执行器的真实提交边界映射为条目结果，并逐项持久化会话、发布跨线程进度。
 * observe 只处理已提交项；其失败属于警告。执行错误进入结果，已确认项绝不重试。
 */
export function executeEntryBatch(
  entries: readonly VaultEntry[],
  request: EntryBatchRequest,
  run: EntryBatchRunner,
  observe: (change: EntryMutation) => RenameOutcome,
  control?: EntryBatchControl,
): EntryBatchResult {
  const plan = planEntryBatch(entries, request);
  const skipped = new Set(plan.skipped);
  const result: EntryBatchResult = {
    completed: [],
    remaining: independentEntryPaths(request.paths).filter((path) => !skipped.has(path)),
    skipped: plan.skipped,
    issues: plan.issues,
    warning: null,
  };
  control?.start(plan.changes.length);
  if (plan.issues.length > 0 || plan.changes.length === 0 || control?.stopped) return result;
  const warnings: string[] = [];
  const confirm = (count: number) => {
    if (
      !Number.isSafeInteger(count) ||
      count < result.completed.length ||
      count > plan.changes.length
    )
      throw new Error("批量操作返回了无效完成数");
    for (const change of plan.changes.slice(result.completed.length, count)) {
      // 先记录提交，再调用会话观察者；异常不能把真实成功项重新归入重试。
      result.completed.push(change);
      try {
        const outcome = observe(change);
        if (outcome.warning !== null) warnings.push(`${change.from}：${outcome.warning}`);
      } catch (error) {
        warnings.push(`${change.from}：文件操作已完成，会话更新失败：${errorMessage(error)}`);
      }
    }
    control?.completed(result.completed.length);
  };
  try {
    const outcome = run(plan.changes, (completed) => {
      confirm(completed);
      control?.running();
      return !control?.stopped;
    });
    if (outcome.warning !== null) warnings.push(outcome.warning);
    if (outcome.issue !== null) result.issues.push(outcome.issue);
    confirm(outcome.completed);
  } catch (error) {
    result.issues.push({ path: "", message: errorMessage(error) });
  }
  const completed = new Set(result.completed.map((change) => change.from));
  result.remaining = result.remaining.filter((path) => !completed.has(path));
  result.warning = warnings.length === 0 ? null : warnings.join("；");
  return result;
}

/**
 * 废纸篓使用系统逐项操作：整批预检后执行，首次失败即停止，回调失败仍返回提交前缀。
 * check 在任何文件变动前失败可抛错；apply 的提交后故障必须以 warning 返回。
 */
export function createSerialEntryBatchRunner(
  check: (changes: EntryMutation[]) => void,
  apply: (change: EntryMutation) => RenameOutcome,
): EntryBatchRunner {
  return (changes, progress) => {
    check(changes);
    const result: EntryBatchExecution = { completed: 0, issue: null, warning: null };
    const warnings: string[] = [];
    let path = "";
    try {
      if (!progress(0)) return result;
      for (const change of changes) {
        path = change.from;
        const outcome = apply(change);
        result.completed += 1;
        if (outcome.warning !== null) warnings.push(`${change.from}：${outcome.warning}`);
        path = "";
        if (!progress(result.completed)) break;
      }
    } catch (error) {
      result.issue = { path, message: errorMessage(error) };
    }
    result.warning = warnings.length === 0 ? null : warnings.join("；");
    return result;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
