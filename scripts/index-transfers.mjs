import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createPublicClient, http } from 'viem';
import { foundry } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(__dirname, '..');
const repoRoot = resolve(backendDir, '..');
const dbDir = resolve(backendDir, 'data');

// ABI with only Transfer event
const erc20TransferAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, name: 'from', type: 'address' },
      { indexed: true, name: 'to', type: 'address' },
      { indexed: false, name: 'value', type: 'uint256' },
    ],
    name: 'Transfer',
    type: 'event',
  },
];

async function main() {
  // 1. Ensure DB directory exists and initialize SQLite DB
  await mkdir(dbDir, { recursive: true });
  const dbPath = resolve(dbDir, 'transfers.db');
  console.log(`[indexer] Database path: ${dbPath}`);
  const db = new Database(dbPath);

  // Enable WAL mode for performance
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      value TEXT NOT NULL,
      transaction_hash TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      UNIQUE(transaction_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Prepare database statements
  const insertTransfer = db.prepare(`
    INSERT OR IGNORE INTO transfers (from_address, to_address, value, transaction_hash, block_number, log_index, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const getSyncState = db.prepare(`
    SELECT value FROM sync_state WHERE key = 'last_synced_block'
  `);

  const updateSyncState = db.prepare(`
    INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_synced_block', ?)
  `);

  // 2. Resolve ETT address & RPC
  let tokenAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3'; // default fallback
  try {
    const broadcastPath = resolve(repoRoot, 'solidity_demos/broadcast/DeployTokenBank.s.sol/31337/run-latest.json');
    const broadcast = JSON.parse(await readFile(broadcastPath, 'utf8'));
    if (broadcast.returns?.token?.value) {
      tokenAddress = broadcast.returns.token.value;
      console.log(`[indexer] Found deployed token address from broadcast: ${tokenAddress}`);
    }
  } catch (error) {
    console.log(`[indexer] Using default token address fallback: ${tokenAddress}`);
  }

  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
  });

  const chainId = await publicClient.getChainId();
  console.log(`[indexer] Connected to RPC ${rpcUrl}, chainId=${chainId}`);
  console.log(`[indexer] Indexing ETT transfers for address: ${tokenAddress}`);

  // Cache for block timestamps to minimize RPC calls
  const blockTimestamps = new Map();
  async function getBlockTimestamp(blockNumber) {
    const num = Number(blockNumber);
    if (blockTimestamps.has(num)) {
      return blockTimestamps.get(num);
    }
    const block = await publicClient.getBlock({ blockNumber });
    const ts = Number(block.timestamp);
    blockTimestamps.set(num, ts);
    return ts;
  }

  // Helper to index a range of blocks
  async function indexRange(fromBlock, toBlock) {
    console.log(`[indexer] Scanning block ${fromBlock} to ${toBlock}...`);
    const logs = await publicClient.getContractEvents({
      address: tokenAddress,
      abi: erc20TransferAbi,
      eventName: 'Transfer',
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });

    if (logs.length === 0) {
      return 0;
    }

    let indexedCount = 0;
    const insertTx = db.transaction((transferLogs) => {
      for (const log of transferLogs) {
        const { from, to, value } = log.args;
        const ts = log.timestamp;
        const info = insertTransfer.run(
          from.toLowerCase(),
          to.toLowerCase(),
          value.toString(),
          log.transactionHash,
          Number(log.blockNumber),
          log.logIndex,
          ts
        );
        if (info.changes > 0) {
          indexedCount++;
        }
      }
    });

    // Populate timestamps for all logs
    const logsWithTime = [];
    for (const log of logs) {
      const ts = await getBlockTimestamp(log.blockNumber);
      logsWithTime.push({ ...log, timestamp: ts });
    }

    insertTx(logsWithTime);
    return indexedCount;
  }

  // 3. Historical Sync
  const lastSyncedRow = getSyncState.get();
  let startBlock = 0;
  if (lastSyncedRow) {
    startBlock = parseInt(lastSyncedRow.value, 10);
  }
  console.log(`[indexer] Last synced block from DB: ${startBlock}`);

  const currentBlock = Number(await publicClient.getBlockNumber());
  console.log(`[indexer] Current block on-chain: ${currentBlock}`);

  if (startBlock < currentBlock) {
    const from = startBlock === 0 ? 0 : startBlock + 1;
    const count = await indexRange(from, currentBlock);
    updateSyncState.run(currentBlock.toString());
    console.log(`[indexer] Historical sync finished. Indexed ${count} new transfers.`);
  } else {
    console.log('[indexer] Already synced with latest block.');
  }

  // 4. Real-time Watching
  let lastSeenBlock = BigInt(currentBlock);
  const unwatch = publicClient.watchBlockNumber({
    onBlockNumber: async (blockNumber) => {
      if (blockNumber <= lastSeenBlock) {
        return;
      }
      const from = lastSeenBlock + 1n;
      lastSeenBlock = blockNumber;

      try {
        const count = await indexRange(from, blockNumber);
        updateSyncState.run(blockNumber.toString());
        if (count > 0) {
          console.log(`[indexer] Indexed ${count} new transfers at block ${blockNumber}`);
        }
      } catch (err) {
        console.error(`[indexer:error] Failed indexing block ${blockNumber}:`, err);
        // Reset lastSeenBlock to retry on next cycle
        lastSeenBlock = from - 1n;
      }
    },
    onError: (error) => console.error('[indexer:error]', error),
  });

  console.log('[indexer] Watching for new transfers...');

  process.once('SIGINT', () => {
    unwatch();
    db.close();
    console.log('\n[indexer] Stopped');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[indexer:fatal]', error);
  process.exit(1);
});
