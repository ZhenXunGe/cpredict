-- The HTTP service verifies EOA, ERC-1271 and ERC-6492 signatures before storage.
-- Preserve existing 65-byte signatures while accepting the same bounded,
-- byte-aligned envelope as server.ts. This does not change signature validation.
ALTER TABLE market_publications
  DROP CONSTRAINT market_publication_signature,
  ADD CONSTRAINT market_publication_signature CHECK (
    octet_length(signature) BETWEEN 4 AND 16386
    AND signature ~ '^0x([0-9a-fA-F]{2})+$'
  );
