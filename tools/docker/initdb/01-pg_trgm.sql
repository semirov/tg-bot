-- Test/CI database bootstrap: расширение нужно для deduplication (pg_trgm SIMILARITY).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
