import { createHash } from 'node:crypto';
import { Prisma, type TraceEntityType } from '@prisma/client';
import { AppError } from './errors.js';

type Tx = Prisma.TransactionClient;

/**
 * 痕迹版本快照：每个痕迹（折角/批注/重读页）的每次变更都追加一条只存差异的快照，
 * 同一实体的快照按实体 version 构成连续链条。任意历史版本都可以从首条全量快照
 * 出发逐条复算，并用 stateHash 校验复算结果未被篡改。
 */

export type DogEarSnapshotState = {
  pageNumber: number;
  reason: string | null;
  deletedAt: string | null;
};

export type AnnotationSnapshotState = {
  startPage: number;
  endPage: number;
  content: string;
  deletedAt: string | null;
};

export type RereadMarkSnapshotState = {
  pageNumber: number;
  reason: string | null;
  deletedAt: string | null;
};

export type TraceSnapshotState = DogEarSnapshotState | AnnotationSnapshotState | RereadMarkSnapshotState;

/** 差异只包含发生变化的字段；值为 null 是有效变更（如清空原因），缺省键表示未变化。 */
export type SnapshotDiff = Record<string, string | number | null>;

export interface SnapshotChainRow {
  version: number;
  diffJson: unknown;
  stateHash: string;
  createdAt: Date;
}

export function dogEarState(row: { pageNumber: number; reason: string | null; deletedAt: Date | null }): DogEarSnapshotState {
  return {
    pageNumber: row.pageNumber,
    reason: row.reason,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null
  };
}

export function annotationState(row: {
  startPage: number;
  endPage: number;
  content: string;
  deletedAt: Date | null;
}): AnnotationSnapshotState {
  return {
    startPage: row.startPage,
    endPage: row.endPage,
    content: row.content,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null
  };
}

export function rereadMarkState(row: {
  pageNumber: number;
  reason: string | null;
  deletedAt: Date | null;
}): RereadMarkSnapshotState {
  return {
    pageNumber: row.pageNumber,
    reason: row.reason,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
  return `{${entries.join(',')}}`;
}

/** 状态哈希与键序无关，保证同一状态在任何进程里复算出相同摘要。 */
export function hashState(state: TraceSnapshotState | SnapshotDiff): string {
  return createHash('sha256').update(canonicalize(state)).digest('hex');
}

export function diffStates(prev: TraceSnapshotState, next: TraceSnapshotState): SnapshotDiff {
  const diff: SnapshotDiff = {};
  for (const key of Object.keys(next)) {
    const field = key as keyof TraceSnapshotState;
    if (prev[field] !== next[field]) {
      diff[key] = next[field] as string | number | null;
    }
  }
  return diff;
}

export function applyDiff(state: SnapshotDiff, diff: SnapshotDiff): SnapshotDiff {
  return { ...state, ...diff };
}

export function statesEqual(left: TraceSnapshotState, right: TraceSnapshotState): boolean {
  return canonicalize(left) === canonicalize(right);
}

/**
 * 追加一条快照。prevState 为 null 表示首版本，直接存全量状态。
 * 对功能上线前已存在的痕迹（实体 version 大于 1 但还没有任何快照），
 * 先以变更前状态补一条全量基线快照，再追加本次差异，保证链条从基线起连续。
 */
export async function appendSnapshot(
  tx: Tx,
  input: {
    userId: string;
    bookId: string;
    entityType: TraceEntityType;
    entityId: string;
    version: number;
    prevState: TraceSnapshotState | null;
    nextState: TraceSnapshotState;
  }
): Promise<void> {
  const tip = await tx.traceSnapshot.aggregate({
    where: { entityType: input.entityType, entityId: input.entityId },
    _max: { version: true }
  });
  const tipVersion = tip._max.version ?? 0;

  if (tipVersion === 0 && input.prevState && input.version > 1) {
    await tx.traceSnapshot.create({
      data: {
        userId: input.userId,
        bookId: input.bookId,
        entityType: input.entityType,
        entityId: input.entityId,
        version: input.version - 1,
        diffJson: input.prevState,
        stateHash: hashState(input.prevState)
      }
    });
  } else if (tipVersion > 0 && tipVersion !== input.version - 1) {
    throw new AppError(500, 'SNAPSHOT_CHAIN_BROKEN', '版本快照链与实体版本不一致');
  }

  await tx.traceSnapshot.create({
    data: {
      userId: input.userId,
      bookId: input.bookId,
      entityType: input.entityType,
      entityId: input.entityId,
      version: input.version,
      diffJson: input.prevState ? diffStates(input.prevState, input.nextState) : input.nextState,
      stateHash: hashState(input.nextState)
    }
  });
}

/**
 * 从首条快照开始逐条应用差异并校验每个版本的 stateHash。
 * 传入 uptoVersion 时复算到指定版本为止；链条缺版本或摘要不一致都会抛错。
 */
export function replayChain(
  rows: SnapshotChainRow[],
  uptoVersion?: number
): { state: TraceSnapshotState; stateHash: string } {
  const [first] = rows;
  if (!first) {
    throw new AppError(404, 'SNAPSHOT_NOT_FOUND', '快照不存在');
  }
  let state: SnapshotDiff = {};
  let stateHash = '';
  let expected = first.version;
  for (const row of rows) {
    if (row.version !== expected) {
      throw new AppError(500, 'SNAPSHOT_CORRUPT', '版本快照链不连续，无法复算');
    }
    state = applyDiff(state, row.diffJson as SnapshotDiff);
    stateHash = hashState(state);
    if (stateHash !== row.stateHash) {
      throw new AppError(500, 'SNAPSHOT_CORRUPT', '版本快照校验失败，无法复算');
    }
    if (uptoVersion !== undefined && row.version >= uptoVersion) {
      return { state: state as TraceSnapshotState, stateHash };
    }
    expected += 1;
  }
  if (uptoVersion !== undefined) {
    throw new AppError(404, 'SNAPSHOT_NOT_FOUND', '指定版本的快照不存在');
  }
  return { state: state as TraceSnapshotState, stateHash };
}

/** 按时间定位快照：链条中 createdAt 不晚于 targetTime 的最后一条。 */
export function snapshotAtTime(rows: SnapshotChainRow[], targetTime: Date): SnapshotChainRow | null {
  let found: SnapshotChainRow | null = null;
  for (const row of rows) {
    if (row.createdAt.getTime() <= targetTime.getTime()) {
      found = row;
    } else {
      break;
    }
  }
  return found;
}
