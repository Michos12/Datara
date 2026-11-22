-- The customer list orders by (created_at, id). Customers created together (one import, one
-- generator run) share created_at, and without id in the index Postgres read and sorted every
-- such customer to return one page (265 ms at A1, 100k customers). With it, a page is an index
-- walk, and searches for common terms walk it until the page is full.
DROP INDEX "customers_organization_id_created_at_idx";
CREATE INDEX "customers_organization_id_created_at_id_idx" ON "customers"("organization_id", "created_at", "id");
