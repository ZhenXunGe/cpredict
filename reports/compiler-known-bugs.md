# Solidity 0.8.36 编译器核查

核查日期：2026-08-08。

- 精确 pragma：生产源码 `pragma solidity 0.8.36`。
- Foundry build-info：`solcVersion = 0.8.36`、`solcLongVersion = 0.8.36`。
- 官方 tag：`v0.8.36`，commit `8a079791d9cca7a6c03fd6a8429b93aa3bddefed`。
- 官方 release 页面标记为正式 Latest release，非 nightly，发布日期 2026-07-09，签名 Verified。
- 官方 `develop` 分支 `docs/bugs_by_version.json` 在核查 commit
  `9b2f86bebbbc22c7c9f5ca41884d47fcc1d0639a` 下返回：
  `{"bugs":[],"released":"2026-07-09"}`。
- 生产 profile：Cancun、optimizer 200、viaIR、`bytecode_hash = none`、`cbor_metadata = false`。
- 差分 profile：同一 0.8.36、optimizer 200、non-IR；协议源码和非 viaIR-only 测试已通过。

来源：

- https://github.com/ethereum/solidity/releases/tag/v0.8.36
- https://docs.soliditylang.org/en/latest/bugs.html
- https://github.com/ethereum/solidity/blob/develop/docs/bugs_by_version.json

发布要求：每次候选版本冻结、外部审计起点和部署当天重新检查 known-bugs；本报告不是未来安全保证。
