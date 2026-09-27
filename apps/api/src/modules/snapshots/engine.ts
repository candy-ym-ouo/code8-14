import { createHash } from 'node:crypto';
import { AppError } from '../../lib/errors.js';

/**
 * 痕迹版本快照的确定性核心。
 *
 * 状态模型：一本书在某个事件位置的全部有效页面痕迹构成一个 TraceDocument。
 * 快照只保存与上一快照的差异（DiffOp 链），事件日志只追加不修改，
 * 因此任意历史位置都可以由「差异链」或「事件流」两条独立路径复算。
 */

export interface DogEarDoc {
  pageNumber: number;
  reason: string | null;
}

export interface AnnotationDoc {
  startPage: number;
  endPage: number;
  content: string;
}

export interface RereadMarkDoc {
  pageNumber: number;
  reason: string | null;
}

export interface TraceDocument {
  dogEars: Record<string, DogEarDoc>;
  annotations: Record<string, AnnotationDoc>;
  rereadMarks: Record<string, RereadMarkDoc>;
}

export const SNAPSHOT_ENTITIES = ['dogEars', 'annotations', 'rereadMarks'] as const;
export type SnapshotEntity = (typeof SNAPSHOT_ENTITIES)[number];
export type EntityDoc = DogEarDoc | AnnotationDoc | RereadMarkDoc;

/** CHANGE 事件载荷：携带实体 after-image，重放不依赖业务表当前状态。 */
export interface ChangePayload {
  entity: SnapshotEntity;
  entityId: string;
  op: 'upsert' | 'remove';
  after?: EntityDoc;
}

/** ROLLBACK 事件载荷：记录目标位置与恢复后状态哈希，供重放时校验。 */
export interface RollbackPayload {
  targetSeq: number;
  stateHash: string;
}

export type SnapshotEventKind = 'CHANGE' | 'ROLLBACK';

export interface SnapshotEventRecord {
  seq: number;
  kind: SnapshotEventKind;
  payload: ChangePayload | RollbackPayload;
  occurredAt: Date;
}

export interface SnapshotMeta {
  /** 快照序号，决定差异链顺序 */
  seq: number;
  /** 快照对应的事件流位置 */
  eventSeq: number;
  stateHash: string;
}

export interface DiffOp {
  op: 'set' | 'del';
  path: string[];
  value?: unknown;
}

export interface RestorePlanItem {
  entity: SnapshotEntity;
  entityId: string;
  op: 'upsert' | 'remove';
  after?: EntityDoc;
}

export function emptyDocument(): TraceDocument {
  return { dogEars: {}, annotations: {}, rereadMarks: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 确定性序列化：对象键排序，数组保序，undefined 归一为 null。 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  if (value === undefined) return null;
  return value;
}

function canonicalEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export function hashDocument(doc: TraceDocument): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(doc))).digest('hex');
}

/** 递归差异：键序确定（排序），输出可重放的 set/del 操作序列。 */
export function diffValues(oldValue: unknown, newValue: unknown, path: string[] = []): DiffOp[] {
  if (isPlainObject(oldValue) && isPlainObject(newValue)) {
    const ops: DiffOp[] = [];
    for (const key of Object.keys(oldValue).sort()) {
      if (!(key in newValue)) ops.push({ op: 'del', path: [...path, key] });
    }
    for (const key of Object.keys(newValue).sort()) {
      if (!(key in oldValue)) {
        ops.push({ op: 'set', path: [...path, key], value: newValue[key] });
      } else {
        ops.push(...diffValues(oldValue[key], newValue[key], [...path, key]));
      }
    }
    return ops;
  }
  if (canonicalEquals(oldValue, newValue)) return [];
  return [{ op: 'set', path, value: newValue }];
}

export function applyDiff(doc: TraceDocument, ops: DiffOp[]): TraceDocument {
  const next = structuredClone(doc) as unknown as Record<string, unknown>;
  for (const op of ops) {
    if (op.path.length === 0) {
      throw new AppError(409, 'SNAPSHOT_CORRUPTED', '快照差异包含非法的根替换操作');
    }
    let node: Record<string, unknown> = next;
    for (const key of op.path.slice(0, -1)) {
      const child = node[key];
      if (!isPlainObject(child)) {
        throw new AppError(409, 'SNAPSHOT_CORRUPTED', '快照差异与基础状态不匹配');
      }
      node = child;
    }
    const leaf = op.path[op.path.length - 1];
    if (leaf === undefined) {
      throw new AppError(409, 'SNAPSHOT_CORRUPTED', '快照差异路径为空');
    }
    if (op.op === 'set') {
      node[leaf] = structuredClone(op.value);
    } else {
      delete node[leaf];
    }
  }
  return next as unknown as TraceDocument;
}

export function applyChange(doc: TraceDocument, change: ChangePayload): TraceDocument {
  const next = structuredClone(doc);
  const bucket: Record<string, EntityDoc | undefined> = next[change.entity];
  if (change.op === 'upsert') {
    if (!change.after) {
      throw new AppError(409, 'SNAPSHOT_CORRUPTED', '变更事件缺少实体快照');
    }
    bucket[change.entityId] = structuredClone(change.after);
  } else {
    delete bucket[change.entityId];
  }
  return next;
}

/** 校验事件序列从 startSeq 开始连续无空洞。 */
export function assertContinuous(events: SnapshotEventRecord[], startSeq = 1): void {
  events.forEach((event, index) => {
    if (event.seq !== startSeq + index) {
      throw new AppError(409, 'SNAPSHOT_CORRUPTED', '事件序列不连续');
    }
  });
}

/**
 * 从完整事件前缀（seq 1..n）重放文档。
 * 遇到 ROLLBACK 事件时递归重放目标位置——历史事件不可变，结果确定。
 */
export function replayEvents(events: SnapshotEventRecord[]): TraceDocument {
  assertContinuous(events);
  let doc = emptyDocument();
  for (const event of events) {
    if (event.kind === 'CHANGE') {
      doc = applyChange(doc, event.payload as ChangePayload);
    } else {
      const payload = event.payload as RollbackPayload;
      doc = replayEvents(events.slice(0, payload.targetSeq));
      if (hashDocument(doc) !== payload.stateHash) {
        throw new AppError(409, 'SNAPSHOT_DIVERGED', '回滚事件与事件流重放结果不一致');
      }
    }
  }
  return doc;
}

/** 沿差异链复算快照文档（deltas 按快照序号升序）。 */
export function recomputeFromDeltas(deltas: DiffOp[][]): TraceDocument {
  let doc = emptyDocument();
  for (const delta of deltas) {
    doc = applyDiff(doc, delta);
  }
  return doc;
}

/**
 * 复算任意事件位置的文档：取 eventSeq 不超过目标位置的最近快照，
 * 再重放其后的事件区间。不变量：每次回滚都会在回滚事件位置落一张
 * 快照，因此该区间只可能包含 CHANGE 事件。
 */
export function materializeAt(
  targetSeq: number,
  snapshots: Array<SnapshotMeta & { delta: DiffOp[] }>,
  events: SnapshotEventRecord[]
): TraceDocument {
  const baseSnapshot = snapshots
    .filter((snapshot) => snapshot.eventSeq <= targetSeq)
    .sort((a, b) => a.eventSeq - b.eventSeq)
    .at(-1);
  let doc: TraceDocument;
  let fromSeq: number;
  if (baseSnapshot) {
    const chain = snapshots
      .filter((snapshot) => snapshot.seq <= baseSnapshot.seq)
      .sort((a, b) => a.seq - b.seq)
      .map((snapshot) => snapshot.delta);
    doc = recomputeFromDeltas(chain);
    if (hashDocument(doc) !== baseSnapshot.stateHash) {
      throw new AppError(409, 'SNAPSHOT_DIVERGED', '快照差异链复算结果与快照哈希不一致');
    }
    fromSeq = baseSnapshot.eventSeq;
  } else {
    doc = emptyDocument();
    fromSeq = 0;
  }
  const range = events
    .filter((event) => event.seq > fromSeq && event.seq <= targetSeq)
    .sort((a, b) => a.seq - b.seq);
  for (const event of range) {
    if (event.kind === 'ROLLBACK') {
      throw new AppError(409, 'SNAPSHOT_CORRUPTED', '快照区间存在未锚定的回滚事件');
    }
    doc = applyChange(doc, event.payload as ChangePayload);
  }
  return doc;
}

/** 按时间定位：最后一个 occurredAt 不晚于 time 的事件位置（无则为 0，即空文档）。 */
export function seqAtTime(events: SnapshotEventRecord[], time: Date): number {
  const at = time.getTime();
  let target = 0;
  for (const event of events) {
    if (event.occurredAt.getTime() <= at && event.seq > target) {
      target = event.seq;
    }
  }
  return target;
}

/** 回滚目标必须指向当前位置之前的某个事件位置（0 表示回到空文档）。 */
export function assertRollbackTarget(targetSeq: number, headSeq: number): void {
  if (!Number.isInteger(targetSeq) || targetSeq < 0 || targetSeq >= headSeq) {
    throw new AppError(422, 'INVALID_ROLLBACK_TARGET', '回滚目标必须是当前位置之前的某个事件位置');
  }
}

/** 并发回滚的版本校验：与数据库 CAS 失败时抛出相同的 409。 */
export function assertHeadVersion(current: number, expected: number): void {
  if (expected !== current) {
    throw new AppError(409, 'STALE_WRITE', '快照版本已变化，请刷新后重试');
  }
}

/** 由当前文档与目标文档计算业务表恢复计划（键序确定）。 */
export function planRestore(current: TraceDocument, target: TraceDocument): RestorePlanItem[] {
  const plan: RestorePlanItem[] = [];
  for (const entity of SNAPSHOT_ENTITIES) {
    const currentBucket: Record<string, EntityDoc | undefined> = current[entity];
    const targetBucket: Record<string, EntityDoc | undefined> = target[entity];
    for (const entityId of Object.keys(targetBucket).sort()) {
      const after = targetBucket[entityId];
      if (after && !canonicalEquals(currentBucket[entityId], after)) {
        plan.push({ entity, entityId, op: 'upsert', after });
      }
    }
    for (const entityId of Object.keys(currentBucket).sort()) {
      if (!(entityId in targetBucket)) {
        plan.push({ entity, entityId, op: 'remove' });
      }
    }
  }
  return plan;
}
