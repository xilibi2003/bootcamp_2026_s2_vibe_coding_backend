import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { generateNonce, SiweMessage } from 'siwe';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(__dirname, '..');
const dbPath = resolve(backendDir, 'data', 'transfers.db');

const JWT_SECRET = process.env.JWT_SECRET ?? 'super-secret-key-tokenbank-ett-1337';
const PORT = process.env.PORT ?? 3001;

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

// Initialize SQLite DB
console.log(`[server] Connecting to database: ${dbPath}`);
const db = new Database(dbPath, { readonly: true });

// In-memory SIWE nonces map: nonce -> expiration timestamp
const nonces = new Map();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Clean up expired nonces periodically
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expires] of nonces.entries()) {
    if (expires < now) {
      nonces.delete(nonce);
    }
  }
}, 60 * 1000);

// JWT verification middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded; // decoded.address is the user's Ethereum address
    next();
  });
}

// 1. GET /api/siwe/nonce - Generate SIWE Nonce
app.get('/api/siwe/nonce', (req, res) => {
  const nonce = generateNonce();
  const expires = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, expires);
  console.log(`[server] Generated nonce: ${nonce} (expires in 5m)`);
  res.json({ nonce });
});

// 2. POST /api/siwe/verify - Verify SIWE Message & Signature
app.post('/api/siwe/verify', async (req, res) => {
  const { message, signature } = req.body;
  if (!message || !signature) {
    return res.status(400).json({ error: 'Missing message or signature' });
  }

  try {
    const siweMessage = new SiweMessage(message);
    const nonce = siweMessage.nonce;

    // Validate nonce is active and has not expired
    const expires = nonces.get(nonce);
    if (!expires || expires < Date.now()) {
      return res.status(400).json({ error: 'Nonce has expired or is invalid. Please request a new nonce.' });
    }
    nonces.delete(nonce); // prevent replay attacks

    // Verify SIWE signature
    const verifyRes = await siweMessage.verify({ signature, nonce });
    const address = verifyRes.data.address;

    console.log(`[server] SIWE Verification successful for address: ${address}`);

    // Issue JWT
    const token = jwt.sign({ address }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ success: true, token, address });
  } catch (error) {
    console.error(`[server:siwe-error] Verification failed:`, error.message);
    res.status(400).json({ error: error.message || 'Signature verification failed' });
  }
});

// 3. GET /api/siwe/me - Check current authentication status
app.get('/api/siwe/me', authenticateToken, (req, res) => {
  res.json({ address: req.user.address });
});

// 4. GET /api/transfers - Get transfer history for the authenticated address
app.get('/api/transfers', authenticateToken, (req, res) => {
  const address = req.user.address.toLowerCase();
  console.log(`[server] Fetching transfers for: ${address}`);

  try {
    const stmt = db.prepare(`
      SELECT * FROM transfers
      WHERE from_address = ? OR to_address = ?
      ORDER BY block_number DESC, log_index DESC
    `);
    const rows = stmt.all(address, address);
    res.json(rows);
  } catch (error) {
    console.error('[server:db-error] Failed to query transfers:', error);
    res.status(500).json({ error: 'Failed to retrieve transfer records' });
  }
});

app.listen(PORT, () => {
  console.log(`[server] REST API server listening at http://localhost:${PORT}`);
});
