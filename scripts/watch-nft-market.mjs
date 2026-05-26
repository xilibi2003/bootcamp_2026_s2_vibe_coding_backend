import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, http } from 'viem';
import { foundry } from 'viem/chains';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(__dirname, '..');
const repoRoot = resolve(backendDir, '..');
const deploymentPath =
  process.env.DEPLOYMENT_FILE ??
  resolve(backendDir, 'deployments', 'anvil-nft-market.json');
const marketArtifactPath = resolve(
  repoRoot,
  'solidity_demos',
  'out',
  'NFTMarket.sol',
  'NFTMarket.json',
);

async function main() {
  const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
  const marketArtifact = JSON.parse(await readFile(marketArtifactPath, 'utf8'));
  const rpcUrl = process.env.RPC_URL ?? deployment.rpcUrl ?? 'http://127.0.0.1:8545';
  const marketAddress = process.env.MARKET_ADDRESS ?? deployment.contracts.market;

  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
  });

  const chainId = await publicClient.getChainId();
  console.log(`[watch] connected ${rpcUrl}, chainId=${chainId}`);
  console.log(`[watch] NFTMarket=${marketAddress}`);
  console.log('[watch] waiting for Listed and Sold events...');

  let lastSeenBlock = await publicClient.getBlockNumber();

  const unwatch = publicClient.watchBlockNumber({
    onBlockNumber: async (blockNumber) => {
      if (blockNumber <= lastSeenBlock) {
        return;
      }

      const fromBlock = lastSeenBlock + 1n;
      lastSeenBlock = blockNumber;

      const [listedLogs, soldLogs] = await Promise.all([
        publicClient.getContractEvents({
          address: marketAddress,
          abi: marketArtifact.abi,
          eventName: 'Listed',
          fromBlock,
          toBlock: blockNumber,
        }),
        publicClient.getContractEvents({
          address: marketAddress,
          abi: marketArtifact.abi,
          eventName: 'Sold',
          fromBlock,
          toBlock: blockNumber,
        }),
      ]);

      const logs = [...listedLogs, ...soldLogs].sort((left, right) => {
        if (left.transactionIndex !== right.transactionIndex) {
          return left.transactionIndex - right.transactionIndex;
        }

        return left.logIndex - right.logIndex;
      });

      for (const log of logs) {
        if (log.eventName === 'Listed') {
          const { seller, tokenId, price } = log.args;
          console.log(
            `[Listed] seller=${seller} tokenId=${tokenId} price=${formatEther(price)} tx=${log.transactionHash}`,
          );
        }

        if (log.eventName === 'Sold') {
          const { buyer, seller, tokenId, price } = log.args;
          console.log(
            `[Sold] buyer=${buyer} seller=${seller} tokenId=${tokenId} price=${formatEther(price)} tx=${log.transactionHash}`,
          );
        }
      }
    },
    onError: (error) => console.error('[watch:error]', error),
  });

  process.once('SIGINT', () => {
    unwatch();
    console.log('\n[watch] stopped');
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
