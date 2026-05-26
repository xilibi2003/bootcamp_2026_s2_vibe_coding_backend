import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseEther,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(__dirname, '..');
const repoRoot = resolve(backendDir, '..');
const artifactsDir = resolve(repoRoot, 'solidity_demos', 'out');
const deploymentPath = resolve(backendDir, 'deployments', 'anvil-nft-market.json');

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';

const sellerPrivateKey =
  process.env.SELLER_PRIVATE_KEY ??
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const buyerPrivateKey =
  process.env.BUYER_PRIVATE_KEY ??
  '0x8b3a350cf5c34c9194ca3a545d1c6d93e6b1ec3b9dd7b07e3fc368e67cf7e7ae';

const seller = privateKeyToAccount(sellerPrivateKey);
const buyer = privateKeyToAccount(buyerPrivateKey);
const price = parseEther(process.env.NFT_PRICE ?? '100');
const tokenSymbol = process.env.TOKEN_SYMBOL ?? 'ETT';
const tokenUri = process.env.TOKEN_URI ?? 'ipfs://example/anvil-1.json';

const publicClient = createPublicClient({
  chain: foundry,
  transport: http(rpcUrl),
});
const sellerClient = createWalletClient({
  account: seller,
  chain: foundry,
  transport: http(rpcUrl),
});
const buyerClient = createWalletClient({
  account: buyer,
  chain: foundry,
  transport: http(rpcUrl),
});

async function readArtifact(contractFileName, contractName) {
  const artifactPath = resolve(artifactsDir, contractFileName, `${contractName}.json`);
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));

  return {
    abi: artifact.abi,
  };
}

async function readDeployment() {
  try {
    return JSON.parse(await readFile(deploymentPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

async function hasContractCode(address) {
  if (!address) {
    return false;
  }

  const code = await publicClient.getCode({ address });
  return Boolean(code && code !== '0x');
}

async function waitForReceipt(hash) {
  return publicClient.waitForTransactionReceipt({ hash });
}

async function main() {
  const chainId = await publicClient.getChainId();
  console.log(`[rpc] connected ${rpcUrl}, chainId=${chainId}`);
  console.log(`[accounts] seller=${seller.address}, buyer=${buyer.address}`);

  const fundGasHash = await sellerClient.sendTransaction({
    to: buyer.address,
    value: parseEther('1'),
  });
  await waitForReceipt(fundGasHash);
  console.log(`[eth] transfer 1 ETH to buyer for gas tx=${fundGasHash}`);

  const myToken = await readArtifact('MyToken.sol', 'MyToken');
  const bootCampS2 = await readArtifact('BootCampS2.sol', 'BootCampS2');
  const nftMarket = await readArtifact('NFTMarket.sol', 'NFTMarket');

  const deployment = await readDeployment();
  if (!deployment) {
    throw new Error(
      `Deployment file not found: ${deploymentPath}. Run "forge script script/DeployNFTMarket.s.sol --rpc-url ${rpcUrl} --broadcast" from solidity_demos first.`,
    );
  }

  const tokenAddress = deployment.contracts?.token;
  const nftAddress = deployment.contracts?.nft;
  const marketAddress = deployment.contracts?.market;
  const hasDeploymentCode =
    (await hasContractCode(tokenAddress)) &&
    (await hasContractCode(nftAddress)) &&
    (await hasContractCode(marketAddress));

  if (!hasDeploymentCode) {
    throw new Error(
      `Deployment addresses are missing code on ${rpcUrl}. Redeploy with "forge script script/DeployNFTMarket.s.sol --rpc-url ${rpcUrl} --broadcast".`,
    );
  }

  console.log(`[deployment] NFTMarket=${marketAddress}`);

  const token = getContract({
    address: tokenAddress,
    abi: myToken.abi,
    client: { public: publicClient, wallet: sellerClient },
  });
  const nft = getContract({
    address: nftAddress,
    abi: bootCampS2.abi,
    client: { public: publicClient, wallet: sellerClient },
  });

  const marketAsSeller = getContract({
    address: marketAddress,
    abi: nftMarket.abi,
    client: { public: publicClient, wallet: sellerClient },
  });
  
  const marketAsBuyer = getContract({
    address: marketAddress,
    abi: nftMarket.abi,
    client: { public: publicClient, wallet: buyerClient },
  });

  const mintHash = await nft.write.mint([seller.address, tokenUri]);
  const mintReceipt = await waitForReceipt(mintHash);
  const transferLog = mintReceipt.logs.find(
    (log) => log.address.toLowerCase() === nftAddress.toLowerCase(),
  );
  const tokenId = transferLog ? BigInt(transferLog.topics[3]) : 1n;
  console.log(`[mint] tokenId=${tokenId} owner=${seller.address} tx=${mintHash}`);

  const fundBuyerHash = await token.write.transfer([buyer.address, parseEther('1000')]);
  await waitForReceipt(fundBuyerHash);
  console.log(`[erc20] transfer 1000 ${tokenSymbol} to buyer tx=${fundBuyerHash}`);

  const approveNftHash = await nft.write.approve([marketAddress, tokenId]);
  await waitForReceipt(approveNftHash);
  console.log(`[approve] market can transfer NFT tokenId=${tokenId} tx=${approveNftHash}`);

  const listHash = await marketAsSeller.write.list([tokenId, price]);
  await waitForReceipt(listHash);
  console.log(`[list] seller=${seller.address} tokenId=${tokenId} price=${price} tx=${listHash}`);

  const buyerToken = getContract({
    address: tokenAddress,
    abi: myToken.abi,
    client: { public: publicClient, wallet: buyerClient },
  });
  const approveTokenHash = await buyerToken.write.approve([marketAddress, price]);
  await waitForReceipt(approveTokenHash);
  console.log(`[approve] market can spend buyer token amount=${price} tx=${approveTokenHash}`);

  const buyHash = await marketAsBuyer.write.buyNFT([tokenId, price]);
  await waitForReceipt(buyHash);
  console.log(`[buy] buyer=${buyer.address} tokenId=${tokenId} price=${price} tx=${buyHash}`);

  const owner = await nft.read.ownerOf([tokenId]);
  console.log(`[result] tokenId=${tokenId} owner=${owner}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
