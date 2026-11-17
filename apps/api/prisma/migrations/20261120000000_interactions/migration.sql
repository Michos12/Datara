-- CreateEnum
CREATE TYPE "InteractionType" AS ENUM ('WEBSITE_VISIT', 'EMAIL_SENT', 'EMAIL_OPENED', 'EMAIL_CLICKED', 'SUPPORT_TICKET', 'REVIEW', 'LOYALTY_SIGNUP', 'CAMPAIGN_RESPONSE', 'OTHER');

-- AlterEnum
ALTER TYPE "ImportEntity" ADD VALUE 'INTERACTIONS';

-- AlterTable
ALTER TABLE "analytics_customer_metrics" ADD COLUMN     "engagement_score" SMALLINT;

-- CreateTable
CREATE TABLE "interactions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "external_id" TEXT,
    "type" "InteractionType" NOT NULL,
    "channel" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interactions_organization_id_customer_id_occurred_at_idx" ON "interactions"("organization_id", "customer_id", "occurred_at");

-- CreateIndex
CREATE INDEX "interactions_organization_id_type_occurred_at_idx" ON "interactions"("organization_id", "type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "interactions_organization_id_external_id_key" ON "interactions"("organization_id", "external_id");

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written additions
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "analytics_customer_metrics" ADD CONSTRAINT "engagement_score_range"
  CHECK ("engagement_score" IS NULL OR "engagement_score" BETWEEN 0 AND 100);
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_channel_length"
  CHECK ("channel" IS NULL OR length("channel") <= 40);

-- Row-level security: strictly the active organization (ADR-0004)
ALTER TABLE "interactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interactions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "interactions_tenant" ON "interactions"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());
