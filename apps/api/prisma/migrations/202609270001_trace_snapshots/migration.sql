-- AlterEnum
ALTER TYPE "ActivityAction" ADD VALUE 'ROLLED_BACK';

-- CreateEnum
CREATE TYPE "TraceEntityType" AS ENUM ('DOG_EAR', 'ANNOTATION', 'REREAD_MARK');

-- CreateTable
CREATE TABLE "trace_snapshots" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "entity_type" "TraceEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "diff_json" JSONB NOT NULL,
    "state_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trace_snapshots_entity_type_entity_id_version_key" ON "trace_snapshots"("entity_type", "entity_id", "version");

-- CreateIndex
CREATE INDEX "trace_snapshots_entity_type_entity_id_created_at_idx" ON "trace_snapshots"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "trace_snapshots_user_id_book_id_created_at_idx" ON "trace_snapshots"("user_id", "book_id", "created_at");

-- AddForeignKey
ALTER TABLE "trace_snapshots" ADD CONSTRAINT "trace_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_snapshots" ADD CONSTRAINT "trace_snapshots_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
