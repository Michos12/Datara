-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DONE', 'DISMISSED', 'EXPIRED');

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "rule_key" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "priority" "Priority" NOT NULL,
    "priority_score" DECIMAL(8,4) NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "opportunity" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "suggested_action" TEXT NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "affected_customers" INTEGER NOT NULL,
    "revenue_at_stake_cents" BIGINT,
    "dismiss_reason" TEXT,
    "status_revenue_cents" BIGINT,
    "status_changed_by_id" UUID,
    "status_changed_at" TIMESTAMPTZ(6),
    "missed_runs" INTEGER NOT NULL DEFAULT 0,
    "first_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_customers" (
    "recommendation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "value_cents" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "recommendation_customers_pkey" PRIMARY KEY ("recommendation_id","customer_id")
);

-- CreateIndex
CREATE INDEX "recommendations_organization_id_status_priority_idx" ON "recommendations"("organization_id", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_organization_id_fingerprint_key" ON "recommendations"("organization_id", "fingerprint");

-- CreateIndex
CREATE INDEX "recommendation_customers_organization_id_recommendation_id__idx" ON "recommendation_customers"("organization_id", "recommendation_id", "value_cents" DESC);

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_customers" ADD CONSTRAINT "recommendation_customers_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written additions
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_dismiss_reason_length"
  CHECK ("dismiss_reason" IS NULL OR length("dismiss_reason") <= 500);

-- Row-level security: strictly the active organization (ADR-0004)
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recommendations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "recommendations_tenant" ON "recommendations"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "recommendation_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recommendation_customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "recommendation_customers_tenant" ON "recommendation_customers"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());
