# Cpredict TypeScript SDK

## Settlement evidence V1

`src/evidence.ts` is the repository's canonical evidence definition. The document contains exactly
these fields in this order and is encoded as UTF-8 JSON without insignificant whitespace:

```json
{
  "version": 1,
  "sourceUri": "https://example.com/result",
  "summary": "Outcome 1 confirmed.",
  "observedAt": "2026-08-08T12:34:56.000Z"
}
```

- `version` is the integer `1`.
- `sourceUri` is trimmed, NFC-normalized, URL-normalized, at most 512 UTF-8 bytes, has no credentials,
  and uses `https:` or `ipfs:`. IPFS sources require a lowercase base32 CIDv1 host.
- `summary` is trimmed, NFC-normalized, non-empty and at most 2,048 UTF-8 bytes.
- `observedAt` is normalized with `Date.toISOString()` to UTC millisecond precision.
- Unknown fields, unpaired UTF-16 surrogates and a canonical document over 4,096 bytes are rejected.

`prepareSettlementEvidenceV1` returns the normalized document, exact canonical bytes, SHA-256
`evidenceHash`, CID and URI. Upload `canonicalBytes` verbatim with media type
`application/vnd.cpredict.settlement-evidence+json;version=1`; do not parse and re-serialize them.

The CID is deterministically reconstructed from the onchain digest as:

```text
0x01       CID version 1
0x55       raw multicodec
0x12 0x20  sha2-256 multihash code and 32-byte length
<digest>   evidenceHash
```

The byte sequence is lower-case base32 encoded with the `b` multibase prefix and exposed as
`ipfs://<cid>`. The all-zero hash means “no evidence” and maps to `null`; it is never treated as an
IPFS object. `CpredictClient.resolve` and `creatorVoid` default to that zero hash when their optional
argument is omitted.
