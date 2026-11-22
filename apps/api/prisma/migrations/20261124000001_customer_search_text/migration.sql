-- Hand-written: customer search (name, email, external ID). The runtime role is bound by RLS,
-- and Postgres never uses an index for a non-leakproof operator such as ILIKE under RLS, nor
-- the column statistics to estimate it: the trigram index was never used, and every search
-- built and case-folded the text of each customer (100 ms at A1). A stored, lowercased copy
-- makes that scan four times cheaper. Adding the column rewrites the table once.
ALTER TABLE "customers" ADD COLUMN "search_text" TEXT GENERATED ALWAYS AS (
  lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' ||
        coalesce("email"::text, '') || ' ' || coalesce("external_id", ''))
) STORED;
DROP INDEX "customers_search_trgm";
