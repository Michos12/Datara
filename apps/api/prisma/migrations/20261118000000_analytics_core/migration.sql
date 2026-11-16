-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LifecycleStatus" AS ENUM ('PROSPECT', 'ACTIVE', 'AT_RISK', 'CHURNED');

-- CreateEnum
CREATE TYPE "Grain" AS ENUM ('DAY', 'WEEK', 'MONTH', 'QUARTER');

-- CreateTable
CREATE TABLE "analytics_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "as_of" DATE NOT NULL,
    "data_version" BIGINT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "definition_versions" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "data_quality" JSONB,
    "stats" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "analytics_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_customer_metrics" (
    "run_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_count" INTEGER NOT NULL,
    "total_net_cents" BIGINT NOT NULL,
    "aov_cents" BIGINT,
    "first_order_date" DATE,
    "last_order_date" DATE,
    "recency_days" INTEGER,
    "tenure_days" INTEGER,
    "frequency_per_month" DECIMAL(10,4),
    "median_gap_days" DECIMAL(10,2),
    "lifecycle_status" "LifecycleStatus" NOT NULL,
    "historical_clv_cents" BIGINT NOT NULL,

    CONSTRAINT "analytics_customer_metrics_pkey" PRIMARY KEY ("run_id","customer_id")
);

-- CreateTable
CREATE TABLE "analytics_period_metrics" (
    "id" BIGSERIAL NOT NULL,
    "run_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "grain" "Grain" NOT NULL,
    "period_start" DATE NOT NULL,
    "metric_key" TEXT NOT NULL,
    "segment_key" TEXT NOT NULL DEFAULT '_all',
    "value" DECIMAL(20,6),
    "numerator" DECIMAL(20,6),
    "denominator" DECIMAL(20,6),

    CONSTRAINT "analytics_period_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_query_cache" (
    "organization_id" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "params_hash" TEXT NOT NULL,
    "data_version" BIGINT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_query_cache_pkey" PRIMARY KEY ("organization_id","metric","params_hash","data_version")
);

-- CreateIndex
CREATE INDEX "analytics_runs_organization_id_status_started_at_idx" ON "analytics_runs"("organization_id", "status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "analytics_customer_metrics_organization_id_run_id_lifecycle_idx" ON "analytics_customer_metrics"("organization_id", "run_id", "lifecycle_status");

-- CreateIndex
CREATE INDEX "analytics_customer_metrics_organization_id_customer_id_idx" ON "analytics_customer_metrics"("organization_id", "customer_id");

-- CreateIndex
CREATE INDEX "analytics_period_metrics_organization_id_metric_key_grain_p_idx" ON "analytics_period_metrics"("organization_id", "metric_key", "grain", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_period_metrics_run_id_grain_period_start_metric_k_key" ON "analytics_period_metrics"("run_id", "grain", "period_start", "metric_key", "segment_key");

-- CreateIndex
CREATE INDEX "analytics_query_cache_organization_id_created_at_idx" ON "analytics_query_cache"("organization_id", "created_at");


-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security: strictly the active organization (ADR-0004)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "analytics_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_runs_tenant" ON "analytics_runs"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "analytics_customer_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_customer_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_customer_metrics_tenant" ON "analytics_customer_metrics"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "analytics_period_metrics" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_period_metrics" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_period_metrics_tenant" ON "analytics_period_metrics"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "analytics_query_cache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "analytics_query_cache" FORCE ROW LEVEL SECURITY;
CREATE POLICY "analytics_query_cache_tenant" ON "analytics_query_cache"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());
