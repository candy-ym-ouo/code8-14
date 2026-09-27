-- CreateEnum
CREATE TYPE "SnapshotEventKind" AS ENUM ('CHANGE', 'ROLLBACK');

-- CreateTable
CREATE TABLE "trace_snapshot_heads" (
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "head_seq" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trace_snapshot_heads_pkey" PRIMARY KEY ("book_id")
);

-- CreateTable
CREATE TABLE "trace_snapshot_events" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SnapshotEventKind" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_snapshot_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trace_snapshots" (
    "id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "event_seq" INTEGER NOT NULL,
    "head_version" INTEGER NOT NULL,
    "label" VARCHAR(200),
    "state_hash" CHAR(64) NOT NULL,
    "delta_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trace_snapshot_events_book_id_seq_key" ON "trace_snapshot_events"("book_id", "seq");

-- CreateIndex
CREATE INDEX "trace_snapshot_events_user_id_occurred_at_idx" ON "trace_snapshot_events"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "trace_snapshots_book_id_seq_key" ON "trace_snapshots"("book_id", "seq");

-- CreateIndex
CREATE INDEX "trace_snapshots_book_id_event_seq_idx" ON "trace_snapshots"("book_id", "event_seq");

-- AddForeignKey
ALTER TABLE "trace_snapshot_heads" ADD CONSTRAINT "trace_snapshot_heads_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_snapshot_heads" ADD CONSTRAINT "trace_snapshot_heads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_snapshot_events" ADD CONSTRAINT "trace_snapshot_events_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_snapshot_events" ADD CONSTRAINT "trace_snapshot_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_snapshots" ADD CONSTRAINT "trace_snapshots_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_snapshots" ADD CONSTRAINT "trace_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
