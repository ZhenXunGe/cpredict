import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Registry } from 'prom-client';
import { RpcReadPool, parseRpcFallbackConfig } from '../../dist/offchain/app-core/src/rpc-pool.js';
import { fetchJson } from '../../dist/offchain/app-core/src/fetch-json.js';
// URLs are passed by the deployment process through private environment variables.
const primary = process.env.CPREDICT_RPC_PREFLIGHT_PRIMARY_URL;
const output = process.env.CPREDICT_RPC_PREFLIGHT_OUTPUT;
let pool;
try {
  if (!primary || !output) throw new Error('missing private configuration');
  const request = async (method, params) => {
    const b = await fetchJson(primary, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)}, 16*1024*1024);
    if (!b || b.error || b.result === null || b.result === undefined) throw new Error('probe failed');
    return b.result;
  };
  const [chain, block, receipt] = await Promise.all([
    request('eth_chainId', []),
    request('eth_getBlockByNumber', ['0x12798228',false]),
    request('eth_getTransactionReceipt', ['0x1f13565f65e3099e856afa03dc840efcd840a577d6c28e491773076eb75abc56']),
  ]);
  if (chain !== '0x66eee' || block.number !== '0x12798228' || receipt.status !== '0x1' || !receipt.logs?.length) throw new Error('reference mismatch');
  const log = receipt.logs[0];
  const probe = {blockNumber:block.number, blockHash:block.hash, transactionHash:receipt.transactionHash, receiptBlockNumber:receipt.blockNumber,receiptBlockHash:receipt.blockHash,logAddress:log.address,logIndex:log.logIndex};
  const fallback = parseRpcFallbackConfig({...process.env,CPREDICT_RPC_PROBE_JSON:JSON.stringify(probe)});
  const registry = new Registry();
  pool = new RpcReadPool({url:primary,logUrl:process.env.CPREDICT_RPC_PREFLIGHT_LOG_URL,chainId:421614,timeoutMs:8000,service:'preflight',fallback,registry});
  await pool.start();
  const metric = (await registry.getMetricsAsJSON()).find(m=>m.name==='cpredict_rpc_eligible');
  const checks = metric.values.map(v=>({provider:v.labels.provider,category:v.labels.category,eligible:v.value===1})).filter(v=>v.provider!=='official'||v.category==='logs');
  const coverage = Object.fromEntries(['read','history','receipt','logs'].map(category=>[category,checks.filter(c=>c.category===category&&c.eligible).length]));
  const passed = Object.values(coverage).every(count=>count>=2);
  const report = {checkedAt:new Date().toISOString(),status:passed?'passed':'insufficient_redundancy',chainId:421614,coverage,checks};
  await mkdir(output,{recursive:true,mode:0o700});
  await writeFile(resolve(output,'probe.json'),JSON.stringify(probe,null,2)+'\n',{mode:0o600});
  await writeFile(resolve(output,'preflight.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
  if(!passed) process.exitCode=2;

} catch { console.error('RPC preflight failed; provider diagnostics and credentials suppressed'); process.exitCode=1; }
finally { pool?.close(); }
