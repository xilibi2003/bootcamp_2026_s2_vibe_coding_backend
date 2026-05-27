import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseUnits,
  formatUnits,
  formatGwei,
} from 'viem';
import { foundry } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try loading .env natively from the backend root if key env vars are not set
if (!process.env.PRIVATE_KEY || !process.env.ERC20_ADDRESS) {
  try {
    const envPath = resolve(__dirname, '..', '.env');
    process.loadEnvFile(envPath);
  } catch (error) {
    // Env file could not be loaded, will fall back to environment variables
  }
}

// 1. Validate Environment Variables
const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const privateKey = process.env.PRIVATE_KEY;
const erc20Address = process.env.ERC20_ADDRESS;

if (!privateKey) {
  console.error('\x1b[31mError: PRIVATE_KEY is not defined in the environment or .env file.\x1b[0m');
  process.exit(1);
}

if (!erc20Address || !isAddress(erc20Address)) {
  console.error(`\x1b[31mError: ERC20_ADDRESS is missing or invalid (${erc20Address}).\x1b[0m`);
  process.exit(1);
}

// 2. Validate CLI Arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('\n\x1b[36m=== EIP-1559 ERC20 Command Line Wallet ===\x1b[0m');
  console.log('\x1b[33mUsage:\x1b[0m');
  console.log('  npm run wallet:transfer -- <to_address> <amount>');
  console.log('  node scripts/cli-wallet.mjs <to_address> <amount>\n');
  console.log('\x1b[33mExample:\x1b[0m');
  console.log('  npm run wallet:transfer -- 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 100\n');
  process.exit(1);
}

const toAddress = args[0];
const amountStr = args[1];

if (!isAddress(toAddress)) {
  console.error(`\x1b[31mError: Recipient address "${toAddress}" is not a valid Ethereum address.\x1b[0m`);
  process.exit(1);
}

const amountNum = Number(amountStr);
if (isNaN(amountNum) || amountNum <= 0) {
  console.error(`\x1b[31mError: Amount "${amountStr}" must be a valid positive number.\x1b[0m`);
  process.exit(1);
}

// Minimal ERC20 ABI containing decimals, symbol, balanceOf, and transfer
const erc20Abi = [
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    name: 'symbol',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

async function main() {
  // Set up wallet account from private key
  let account;
  try {
    const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    account = privateKeyToAccount(formattedKey);
  } catch (error) {
    console.error(`\x1b[31mError parsing private key: ${error.message}\x1b[0m`);
    process.exit(1);
  }

  // Set up clients
  const publicClient = createPublicClient({
    chain: foundry,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain: foundry,
    transport: http(rpcUrl),
  });

  // Verify connection
  try {
    const chainId = await publicClient.getChainId();
    console.log(`\x1b[32m✔ Connected to network at ${rpcUrl} (Chain ID: ${chainId})\x1b[0m`);
  } catch (error) {
    console.error(`\x1b[31mError: Could not connect to RPC at ${rpcUrl}. Make sure Anvil is running. (${error.message})\x1b[0m`);
    process.exit(1);
  }

  // Load contract details dynamically
  let symbol, decimals;
  try {
    symbol = await publicClient.readContract({
      address: erc20Address,
      abi: erc20Abi,
      functionName: 'symbol',
    });
    decimals = await publicClient.readContract({
      address: erc20Address,
      abi: erc20Abi,
      functionName: 'decimals',
    });
  } catch (error) {
    console.error(`\x1b[31mError: Failed to query ERC20 metadata at address ${erc20Address}. Is the contract deployed? (${error.message})\x1b[0m`);
    process.exit(1);
  }

  const parsedAmount = parseUnits(amountStr, decimals);
  console.log(`\x1b[34mℹ Token Details: ${symbol} (Decimals: ${decimals}) at ${erc20Address}\x1b[0m`);

  // Check sender balance
  const senderBalance = await publicClient.readContract({
    address: erc20Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  if (senderBalance < parsedAmount) {
    console.error(`\x1b[31mError: Insufficient balance. sender has ${formatUnits(senderBalance, decimals)} ${symbol}, but tried to transfer ${amountStr} ${symbol}.\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[34mℹ Sender Address: ${account.address} (Balance: ${formatUnits(senderBalance, decimals)} ${symbol})\x1b[0m`);
  console.log(`\x1b[34mℹ Recipient:      ${toAddress}\x1b[0m`);
  console.log(`\x1b[34mℹ Amount:         ${amountStr} ${symbol}\x1b[0m`);

  // 3. EIP-1559 Gas Estimation
  console.log('\nEstimating EIP-1559 gas fees...');
  const feeEstimate = await publicClient.estimateFeesPerGas();
  const maxFeePerGas = feeEstimate.maxFeePerGas;
  const maxPriorityFeePerGas = feeEstimate.maxPriorityFeePerGas;

  console.log(`  └─ Max Fee Per Gas:      \x1b[33m${formatGwei(maxFeePerGas)} gwei\x1b[0m`);
  console.log(`  └─ Max Priority Fee/Gas:  \x1b[33m${formatGwei(maxPriorityFeePerGas)} gwei\x1b[0m`);

  console.log('\nSending EIP-1559 transfer transaction...');
  const hash = await walletClient.writeContract({
    address: erc20Address,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [toAddress, parsedAmount],
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  console.log(`\x1b[32m✔ Transaction broadcasted! Hash: ${hash}\x1b[0m`);
  console.log('Waiting for receipt...');

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  
  // Query new balances
  const newSenderBalance = await publicClient.readContract({
    address: erc20Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });

  const newRecipientBalance = await publicClient.readContract({
    address: erc20Address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [toAddress],
  });

  // Calculate actual transaction cost (for gas)
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice;
  const txCostWei = gasUsed * effectiveGasPrice;
  const txCostEth = formatUnits(txCostWei, 18);

  console.log('\n\x1b[32m🎉 Transaction Confirmed in Block', receipt.blockNumber, '🎉\x1b[0m');
  console.log('================================================================');
  console.log(`\x1b[1mTransaction Details:\x1b[22m`);
  console.log(`  ├─ Status:               \x1b[32mSUCCESS\x1b[0m`);
  console.log(`  ├─ Transaction Type:     EIP-1559 (Type 2)`);
  console.log(`  ├─ Gas Used:             ${gasUsed.toLocaleString()} units`);
  console.log(`  ├─ Effective Gas Price:  ${formatGwei(effectiveGasPrice)} gwei`);
  console.log(`  ├─ Gas Fee Paid:         ${txCostEth} ETH`);
  console.log(`  └─ Hash:                 \x1b[36m${receipt.transactionHash}\x1b[0m`);
  console.log('----------------------------------------------------------------');
  console.log(`\x1b[1mBalances Summary:\x1b[22m`);
  console.log(`  ├─ Sender New Balance:   \x1b[35m${formatUnits(newSenderBalance, decimals)} ${symbol}\x1b[0m`);
  console.log(`  └─ Recipient Balance:    \x1b[35m${formatUnits(newRecipientBalance, decimals)} ${symbol}\x1b[0m`);
  console.log('================================================================\n');
}

main().catch((error) => {
  console.error('\x1b[31mFatal Error executing transfer:\x1b[0m', error);
  process.exit(1);
});
