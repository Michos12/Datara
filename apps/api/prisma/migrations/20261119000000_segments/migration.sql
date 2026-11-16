
-- AlterTable
ALTER TABLE "analytics_runs" ADD COLUMN     "segment_config_id" UUID,
ADD COLUMN     "segment_config_version" INTEGER;

-- AlterTable
ALTER TABLE "analytics_customer_metrics" ADD COLUMN     "f_score" SMALLINT,
ADD COLUMN     "f_value" INTEGER,
ADD COLUMN     "m_score" SMALLINT,
ADD COLUMN     "m_value_cents" BIGINT,
ADD COLUMN     "r_score" SMALLINT,
ADD COLUMN     "segment_key" TEXT;

-- CreateTable
CREATE TABLE "segment_configs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segment_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "segment_configs_organization_id_version_key" ON "segment_configs"("organization_id", "version");

-- CreateIndex
CREATE INDEX "analytics_customer_metrics_organization_id_run_id_segment_k_idx" ON "analytics_customer_metrics"("organization_id", "run_id", "segment_key");

-- AddForeignKey
ALTER TABLE "segment_configs" ADD CONSTRAINT "segment_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one active segment configuration per organization.
CREATE UNIQUE INDEX "segment_configs_one_active" ON "segment_configs" ("organization_id")
  WHERE "is_active";

ALTER TABLE "analytics_customer_metrics" ADD CONSTRAINT "rfm_scores_range" CHECK (
  ("r_score" IS NULL OR "r_score" BETWEEN 1 AND 5) AND
  ("f_score" IS NULL OR "f_score" BETWEEN 1 AND 5) AND
  ("m_score" IS NULL OR "m_score" BETWEEN 1 AND 5)
);


-- Backfill: every existing organization gets the default configuration as version 1
-- (DEFAULT_SEGMENT_CONFIG in packages/contracts/src/segments.ts at the time of this migration).
INSERT INTO "segment_configs" ("id", "organization_id", "version", "config", "is_active")
SELECT gen_random_uuid(), o."id", 1, '{"lookbackDays":365,"scoring":{"recency":"thresholds","frequency":"thresholds","monetary":"quintile"},"frequencyThresholds":[2,3,4,6],"monetaryThresholds":null,"rules":[{"key":"champions","name":"Champions","color":"#1d7a4d","description":"Bought recently and buy often.","r":[4,5],"f":[4,5]},{"key":"cant_lose_them","name":"Can''t Lose Them","color":"#b43a32","description":"Were top customers by frequency and spend, but have gone quiet.","r":[1,2],"f":[4,5],"m":[4,5]},{"key":"at_risk","name":"At Risk","color":"#d9822b","description":"Used to buy regularly, not recently.","r":[1,2],"f":[3,5]},{"key":"loyal","name":"Loyal Customers","color":"#2f5bd3","description":"Buy regularly.","r":[3,5],"f":[3,5]},{"key":"potential_loyalists","name":"Potential Loyalists","color":"#2a9d8f","description":"Recent customers who have made a second purchase.","r":[4,5],"f":[2,2]},{"key":"new_customers","name":"New Customers","color":"#7c9cf5","description":"Very recent first purchase.","r":[5,5],"f":[1,1]},{"key":"promising","name":"Promising","color":"#4fc1b3","description":"Recent first purchase.","r":[4,4],"f":[1,1]},{"key":"need_attention","name":"Need Attention","color":"#c9a227","description":"Middling recency and low frequency.","r":[3,3],"f":[1,2]},{"key":"hibernating","name":"Hibernating","color":"#8a92a1","description":"Low recency and frequency.","r":[2,2],"f":[1,2]},{"key":"lost","name":"Lost","color":"#5b6474","description":"Lowest recency and frequency.","r":[1,1],"f":[1,2]}]}'::jsonb, true
FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "segment_configs" s WHERE s."organization_id" = o."id");

-- Row-level security: strictly the active organization (ADR-0004). Enabled after the backfill,
-- because FORCE applies to the migration role too (no tenant context here).
ALTER TABLE "segment_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "segment_configs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "segment_configs_tenant" ON "segment_configs"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());
