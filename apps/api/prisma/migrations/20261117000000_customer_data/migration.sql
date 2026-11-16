-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportEntity" AS ENUM ('CUSTOMERS', 'ORDERS');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'VALIDATING', 'VALIDATED', 'IMPORTING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "external_id" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" CITEXT,
    "phone" TEXT,
    "country" CHAR(2),
    "region" TEXT,
    "city" TEXT,
    "registered_at" DATE,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "marketing_consent" BOOLEAN NOT NULL DEFAULT false,
    "anonymized_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID,
    "external_id" TEXT,
    "ordered_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'COMPLETED',
    "channel" TEXT,
    "gross_cents" BIGINT NOT NULL,
    "discount_cents" BIGINT NOT NULL DEFAULT 0,
    "tax_cents" BIGINT NOT NULL DEFAULT 0,
    "refunded_cents" BIGINT NOT NULL DEFAULT 0,
    "net_cents" BIGINT GENERATED ALWAYS AS ("gross_cents" - "discount_cents" - "refunded_cents") STORED,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "external_id" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "entity" "ImportEntity" NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "file_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "mapping" JSONB,
    "rows_total" INTEGER NOT NULL DEFAULT 0,
    "rows_valid" INTEGER NOT NULL DEFAULT 0,
    "rows_failed" INTEGER NOT NULL DEFAULT 0,
    "rows_inserted" INTEGER NOT NULL DEFAULT 0,
    "rows_updated" INTEGER NOT NULL DEFAULT 0,
    "error_sample" JSONB NOT NULL DEFAULT '[]',
    "error_file_key" TEXT,
    "failure_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organization_id_email_idx" ON "customers"("organization_id", "email");

-- CreateIndex
CREATE INDEX "customers_organization_id_created_at_idx" ON "customers"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_organization_id_external_id_key" ON "customers"("organization_id", "external_id");

-- CreateIndex
CREATE INDEX "orders_organization_id_ordered_at_idx" ON "orders"("organization_id", "ordered_at");

-- CreateIndex
CREATE INDEX "orders_organization_id_customer_id_ordered_at_idx" ON "orders"("organization_id", "customer_id", "ordered_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_organization_id_external_id_key" ON "orders"("organization_id", "external_id");

-- CreateIndex
CREATE INDEX "order_items_organization_id_order_id_idx" ON "order_items"("organization_id", "order_id");

-- CreateIndex
CREATE INDEX "order_items_organization_id_product_id_idx" ON "order_items"("organization_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_organization_id_external_id_key" ON "products"("organization_id", "external_id");

-- CreateIndex
CREATE INDEX "imports_organization_id_created_at_idx" ON "imports"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written additions
-- ─────────────────────────────────────────────────────────────────────────────

-- Data integrity (amounts are minor units; see docs/03-data-model.md §1)
ALTER TABLE "orders" ADD CONSTRAINT "orders_amounts_nonneg"
  CHECK ("gross_cents" >= 0 AND "discount_cents" >= 0 AND "tax_cents" >= 0 AND "refunded_cents" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_le_gross"
  CHECK ("discount_cents" <= "gross_cents");
ALTER TABLE "orders" ADD CONSTRAINT "orders_refund_le_paid"
  CHECK ("refunded_cents" <= "gross_cents" - "discount_cents");
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_pos" CHECK ("quantity" > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_nonneg" CHECK ("unit_price_cents" >= 0);
ALTER TABLE "customers" ADD CONSTRAINT "customers_country_format"
  CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

-- Only countable orders feed purchase metrics (docs/05-analytics-methodology.md §3).
CREATE INDEX "orders_countable_idx" ON "orders" ("organization_id", "customer_id", "ordered_at")
  WHERE "deleted_at" IS NULL AND "status" IN ('COMPLETED', 'PARTIALLY_REFUNDED');

-- Customer search by name, email or external ID.
CREATE INDEX "customers_search_trgm" ON "customers" USING gin (
  (coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' ||
   coalesce("email"::text, '') || ' ' || coalesce("external_id", '')) gin_trgm_ops
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security: strictly the active organization (ADR-0004)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customers_tenant" ON "customers"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "orders_tenant" ON "orders"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "order_items_tenant" ON "order_items"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "products_tenant" ON "products"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());

ALTER TABLE "imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "imports_tenant" ON "imports"
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());
