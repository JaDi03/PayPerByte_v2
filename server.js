import express from 'express';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import cors from 'cors';
import { toHex, getAddress, createPublicClient, http } from 'viem';
import { arcTestnet } from 'viem/chains';
import crypto from 'crypto';

// Node 18 compatibility for uuid
if (typeof global.crypto === 'undefined') {
    global.crypto = crypto;
}

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ============================================================
// CONFIGURATION
// ============================================================
const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;
const ENTITY_SECRET = process.env.ENTITY_SECRET;
const MERCHANT_WALLET = process.env.CIRCLE_WALLET_ADDRESS;
const GATEWAY_CONTRACT = process.env.GATEWAY_CONTRACT || '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const USDC_ARC = process.env.USDC_ARC || '0x3600000000000000000000000000000000000000';
const ARC_RPC = process.env.ARC_RPC || 'https://rpc.testnet.arc.network';
const PRICE_PER_MB = parseFloat(process.env.PRICE_PER_MB || '0.0038');
const MB_PER_PAYMENT = parseInt(process.env.MB_PER_PAYMENT || '50');
const AUTO_RENEW_THRESHOLD = parseFloat(process.env.AUTO_RENEW_THRESHOLD || '0.8');
const MAC_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

// ============================================================
// CIRCLE CLIENTS
// ============================================================
const circleClient = initiateDeveloperControlledWalletsClient({
    apiKey: CIRCLE_API_KEY,
    entitySecret: ENTITY_SECRET,
});

const gateway = new BatchFacilitatorClient({
    url: 'https://gateway-api-testnet.circle.com'
});

const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC)
});

// ============================================================
// STATE
// ============================================================
const activeUsers = new Map();
let totalRevenue = 0;
let recentEvents = [];
let walletSetId = process.env.WALLET_SET_ID;
let agentStatus = { state: 'idle', lastAction: null, lastRun: null };

// ============================================================
// HELPERS
// ============================================================
function logEvent(type, message) {
    const event = {
        id: uuidv4(),
        timestamp: new Date().toLocaleTimeString(),
        type,
        message
    };
    recentEvents.unshift(event);
    if (recentEvents.length > 50) recentEvents.pop();
    console.log(`[${type.toUpperCase()}] ${message}`);
}

function getClientIp(req) {
    const ip = req.ip || req.connection.remoteAddress || '127.0.0.1';
    const cleanIp = ip.replace('::ffff:', '');
    return cleanIp === '::1' ? '127.0.0.1' : cleanIp;
}

function isValidIp(ip) {
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?::(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

async function ensureWalletSet() {
    if (walletSetId) return walletSetId;
    try {
        const res = await circleClient.listWalletSets();
        if (res.data?.walletSets?.length > 0) {
            walletSetId = res.data.walletSets[0].id;
        } else {
            const createRes = await circleClient.createWalletSet({ name: "PayPerByte Station" });
            walletSetId = createRes.data?.walletSet?.id;
        }
        return walletSetId;
    } catch (e) {
        console.error("Wallet set error:", e.message);
        throw e;
    }
}

async function getMacFromIp(ip) {
    if (!isValidIp(ip)) return "UNKNOWN_MAC";
    return new Promise((resolve) => {
        exec(`arp -n ${ip} 2>/dev/null || echo "NO_MAC"`, (err, stdout) => {
            if (err) return resolve("UNKNOWN_MAC");
            const match = stdout.match(/([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/i);
            if (match) {
                let mac = match[0].toUpperCase().replace(/[:-]/g, '');
                mac = mac.match(/.{1,2}/g).join(':');
                resolve(mac);
            } else resolve("UNKNOWN_MAC");
        });
    });
}

function getLocalIp() {
    return new Promise((resolve) => {
        exec("ip -4 addr show wlan0 | grep -oP '(?<=inet\\s)\\d+(\\.\\d+){3}'", (err, stdout) => {
            if (err || !stdout.trim()) return resolve('10.42.0.1'); // Fallback
            resolve(stdout.trim().split('\n')[0]);
        });
    });
}

// ============================================================
// BANDWIDTH AGENT
// ============================================================
class BandwidthAgent {
    constructor() {
        this.isRunning = false;
        this.intervalMs = 20000; // Increased to 20s for stability
        this.agentId = uuidv4();
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logEvent('system', `Bandwidth Agent #${this.agentId.slice(0,8)} started`);
        this.loop();
    }

    stop() {
        this.isRunning = false;
        logEvent('system', 'Bandwidth Agent stopped');
    }

    async loop() {
        while (this.isRunning) {
            try {
                await this.tick();
            } catch (e) {
                console.error('Agent tick error:', e);
            }
            await new Promise(r => setTimeout(r, this.intervalMs));
        }
    }

    async tick() {
        agentStatus.lastRun = new Date().toISOString();

        // 1. Monitor bandwidth usage via iptables
        await this.measureBandwidth();

        // 2. Enforce access policies
        await this.enforcePolicies();

        // 3. Auto-renew payments for active users near limit
        await this.autoRenewPayments();

        // 4. Update agent status
        agentStatus.state = 'active';
        agentStatus.lastAction = `Processed ${activeUsers.size} users`;
    }

    async measureBandwidth() {
        if (process.platform === 'win32') {
            // Simulation mode for Windows dev
            activeUsers.forEach((data) => {
                data.bytesUsed += 0.05 * 1024 * 1024; // ~50KB per tick
            });
            return;
        }

        return new Promise((resolve) => {
            exec('sudo iptables -L PAYPERBYTE -v -n -x 2>/dev/null', (err, stdout) => {
                if (err) {
                    resolve();
                    return;
                }
                const lines = stdout.split('\n');
                activeUsers.forEach((data, ip) => {
                    let totalBytes = 0;
                    lines.forEach(line => {
                        if (line.includes(ip)) {
                            const parts = line.trim().split(/\s+/);
                            const bytes = parseInt(parts[1]);
                            if (!isNaN(bytes)) totalBytes += bytes;
                        }
                    });
                    if (totalBytes > 0) {
                        data.bytesUsed = totalBytes;
                    }
                });
                resolve();
            });
        });
    }

    async enforcePolicies() {
        activeUsers.forEach((data, ip) => {
            const usagePercent = data.bytesUsed / (data.mbLimit * 1024 * 1024);

            if (usagePercent >= AUTO_RENEW_THRESHOLD && data.status !== 'renewing') {
                // Mark for auto-renewal
                data.status = 'renewing';
                logEvent('system', `User ${ip.slice(0,12)}... at ${(usagePercent*100).toFixed(0)}% - triggering auto-renew`);
            }
        });
    }

    async autoRenewPayments() {
        for (const [ip, data] of activeUsers.entries()) {
            if (data.status === 'renewing' && !data.renewingLock) {
                data.renewingLock = true;
                try {
                    const success = await this.executeNanopayment(data, ip);
                    if (success) {
                        data.mbLimit += MB_PER_PAYMENT;
                        data.status = 'active';
                        data.bytesUsed = 0; // Reset counter for new quota
                        logEvent('payment', `Auto-renewed +${MB_PER_PAYMENT}MB for ${ip.slice(0,12)}...`);
                        this.unblockIp(ip);
                        this.addQuotaRule(ip, MB_PER_PAYMENT);
                    }
                } catch (e) {
                    logEvent('system', `Auto-renew failed for ${ip.slice(0,12)}...: ${e.message}`);
                } finally {
                    data.renewingLock = false;
                }
            }
        }
    }

    async executeNanopayment(userData, clientIp) {
        try {
            const amountStr = (PRICE_PER_MB * MB_PER_PAYMENT).toFixed(6);
            const amountBaseUnits = BigInt(Math.floor(parseFloat(amountStr) * 1000000)).toString();

            // 1. Create requirements
            const requirements = {
                scheme: "exact",
                network: "eip155:5042002",
                asset: USDC_ARC,
                amount: amountBaseUnits,
                payTo: getAddress(MERCHANT_WALLET),
                maxTimeoutSeconds: 345600,
                extra: {
                    name: "GatewayWalletBatched",
                    version: "1",
                    verifyingContract: getAddress(GATEWAY_CONTRACT),
                }
            };

            // 2. Sign authorization
            const nonce = toHex(uuidv4().replace(/-/g, ''), { size: 32 });
            const validBefore = Math.floor(Date.now() / 1000) + 345600; // 4 days

            const typedData = {
                domain: {
                    name: 'GatewayWalletBatched',
                    version: '1',
                    chainId: 5042002,
                    verifyingContract: getAddress(GATEWAY_CONTRACT)
                },
                types: {
                    EIP712Domain: [
                        { name: 'name', type: 'string' },
                        { name: 'version', type: 'string' },
                        { name: 'chainId', type: 'uint256' },
                        { name: 'verifyingContract', type: 'address' }
                    ],
                    TransferWithAuthorization: [
                        { name: 'from', type: 'address' },
                        { name: 'to', type: 'address' },
                        { name: 'value', type: 'uint256' },
                        { name: 'validAfter', type: 'uint256' },
                        { name: 'validBefore', type: 'uint256' },
                        { name: 'nonce', type: 'bytes32' }
                    ]
                },
                primaryType: 'TransferWithAuthorization',
                message: {
                    from: getAddress(userData.walletAddress),
                    to: getAddress(MERCHANT_WALLET),
                    value: amountBaseUnits,
                    validAfter: "0",
                    validBefore: validBefore.toString(),
                    nonce: nonce
                }
            };

            const signRes = await circleClient.signTypedData({
                idempotencyKey: uuidv4(),
                walletAddress: getAddress(userData.walletAddress),
                blockchain: 'ARC-TESTNET',
                data: JSON.stringify(typedData)
            });

            // 3. Build full x402 payload (SDK v3.0.2)
            const payload = {
                x402Version: 2,
                resource: {
                    url: '/api/access/unlock',
                    description: 'Bandwidth Access',
                    mimeType: 'application/octet-stream'
                },
                accepted: requirements,
                payload: {
                    scheme: "GatewayWalletBatched",
                    network: "eip155:5042002",
                    authorization: typedData.message,
                    signature: signRes.data?.signature
                }
            };

            // 4. Verify
            const verify = await gateway.verify(payload, requirements);
            if (!verify.isValid) {
                // When verify fails with insufficient_balance → block user
                if (verify.invalidReason === 'insufficient_balance') {
                    const user = activeUsers.get(clientIp);
                    if (user) user.status = 'blocked';
                    if (process.platform !== 'win32') {
                        exec(`sudo iptables -D PAYPERBYTE -s ${clientIp} -j ACCEPT 2>/dev/null`);
                        exec(`sudo iptables -D PAYPERBYTE -d ${clientIp} -j ACCEPT 2>/dev/null`);
                        exec(`sudo iptables -t nat -D PAYPERBYTE_NAT -s ${clientIp} -j RETURN 2>/dev/null`);
                    }
                    logEvent('system', `🚫 Insufficient Gateway balance — blocking ${clientIp.slice(0,12)}`);
                } else {
                    logEvent('system', `Auto-renew verify failed: ${verify.invalidReason}`);
                }
                return false;
            }

            // 5. Settle
            const settle = await gateway.settle(payload, requirements);
            if (!settle.success) {
                throw new Error(`Settle failed: ${settle.errorReason}`);
            }

            totalRevenue += parseFloat(amountStr);

            // Track per-user payment telemetry
            const userEntry = activeUsers.get(clientIp);
            if (userEntry) {
                userEntry.signaturesCount = (userEntry.signaturesCount || 0) + 1;
                userEntry.totalPaid = (userEntry.totalPaid || 0) + parseFloat(amountStr);
                userEntry.mbConsumed = (userEntry.mbConsumed || 0) + parseFloat(amountStr) / PRICE_PER_MB;
                userEntry.lastSignatureAt = Date.now();
            }
            const sig = activeUsers.get(clientIp)?.signaturesCount || 1;
            logEvent('signature', `✍️ Firma #${sig} — ${amountStr} USDC — ${clientIp.slice(0,12)}`);
            return true;

        } catch (e) {
            console.error('Nanopayment error:', e);
            return false;
        }
    }

    blockIp(ip) {
        if (process.platform === 'win32' || !isValidIp(ip)) return;
        exec(`sudo iptables -D PAYPERBYTE -s ${ip} -j ACCEPT 2>/dev/null; sudo iptables -I PAYPERBYTE 1 -s ${ip} -j DROP 2>/dev/null`);
    }

    unblockIp(ip) {
        if (process.platform === 'win32' || !isValidIp(ip)) return;
        exec(`sudo iptables -D PAYPERBYTE -s ${ip} -j DROP 2>/dev/null`);
    }

    addQuotaRule(ip, mb) {
        // No quota rules anymore - gateway balance enforces limit
    }
}

const bandwidthAgent = new BandwidthAgent();

// ============================================================
// NETWORK SETUP (Walled Garden)
// ============================================================
const WHITELIST_DOMAINS = [
    'api.circle.com', 
    'rpc.testnet.arc.network', 
    'faucet.testnet.arc.network',
    'connectivitycheck.gstatic.com', // Android
    'connectivitycheck.android.com', // Android
    'captive.apple.com'              // iOS
];

async function setupWalledGarden() {
    if (process.platform === 'win32') {
        logEvent('system', 'Running in simulation mode (Windows)');
        return;
    }
    logEvent('system', 'Setting up network walled garden (Safe Mode)...');

    // 0. Enable IP forwarding so laptop routes traffic between WiFi and internet
    exec('echo 1 | sudo tee /proc/sys/net/ipv4/ip_forward');

    // 1. Create custom chains if they don't exist (never touches system chains)
    exec('sudo iptables -N PAYPERBYTE 2>/dev/null');
    exec('sudo iptables -t nat -N PAYPERBYTE_NAT 2>/dev/null');

    // 2. Clear ONLY our custom chains
    exec('sudo iptables -F PAYPERBYTE 2>/dev/null');
    exec('sudo iptables -t nat -F PAYPERBYTE_NAT 2>/dev/null');

    // 3. Hook into system chains (only if not already hooked)
    exec('sudo iptables -C FORWARD -j PAYPERBYTE 2>/dev/null || sudo iptables -I FORWARD 1 -j PAYPERBYTE');
    exec('sudo iptables -t nat -C PREROUTING -j PAYPERBYTE_NAT 2>/dev/null || sudo iptables -t nat -I PREROUTING 1 -j PAYPERBYTE_NAT');

    // 3b. NAT masquerade: allows phone traffic to go out through ethernet to internet
    exec('sudo iptables -t nat -C POSTROUTING -o enp9s0 -j MASQUERADE 2>/dev/null || sudo iptables -t nat -A POSTROUTING -o enp9s0 -j MASQUERADE');

    // 4. Allow established connections, DNS, DHCP and portal access
    exec('sudo iptables -A PAYPERBYTE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT');
    exec('sudo iptables -A PAYPERBYTE -p udp --dport 53 -j ACCEPT');
    exec('sudo iptables -A PAYPERBYTE -p udp --dport 67:68 --sport 67:68 -j ACCEPT');
    exec('sudo iptables -A PAYPERBYTE -p tcp --dport 3000 -j ACCEPT');

    // 5. Captive Portal redirection (in our NAT chain, not system's)
    const localIp = await getLocalIp();
    logEvent('system', `Captive Portal: Redirecting port 80 to ${localIp}:3000`);
    exec(`sudo iptables -t nat -A PAYPERBYTE_NAT -p tcp --dport 80 -j DNAT --to-destination ${localIp}:3000`);

    // 6. Final Block in our chain
    exec('sudo iptables -A PAYPERBYTE -j DROP');
    logEvent('system', 'Walled garden active - IP forwarding enabled - NAT configured');
}


// ============================================================
// STATIC FILES
// ============================================================
app.use(express.static(path.join(__dirname, 'dist')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ============================================================
// CAPTIVE PORTAL DETECTION — Smart 204 for paid users
// Android checks /generate_204, iOS checks /hotspot-detect.html
// Return 204 for paid users → OS dismisses captive portal notification
// ============================================================
function handleCaptiveCheck(req, res) {
    const clientIp = getClientIp(req);
    const user = activeUsers.get(clientIp);
    if (user && (user.status === 'active' || user.status === 'renewing')) {
        // Tell Android/iOS: "No captive portal — internet is free!"
        return res.status(204).send();
    }
    // Unpaid: redirect to portal
    res.redirect(`http://${req.headers.host || '192.168.4.1'}/`);
}

app.get('/generate_204', handleCaptiveCheck);
app.get('/hotspot-detect.html', handleCaptiveCheck);
app.get('/success.txt', (req, res) => {
    const clientIp = getClientIp(req);
    const user = activeUsers.get(clientIp);
    if (user && user.status === 'active') return res.send('success');
    res.redirect(`http://${req.headers.host || '192.168.4.1'}/`);
});

// ============================================================
// API ROUTES
// ============================================================

// --- Agent Status ---
app.get('/api/agent/status', (req, res) => {
    res.json({
        ...agentStatus,
        activeUsers: activeUsers.size,
        totalRevenue: totalRevenue.toFixed(6),
        uptime: process.uptime()
    });
});

// --- User Identification & Wallet ---
app.get('/api/wallet/identify', async (req, res) => {
    try {
        const clientIp = getClientIp(req);
        let mac = await getMacFromIp(clientIp);

        if (mac === "UNKNOWN_MAC") {
            await new Promise(r => setTimeout(r, 1000));
            mac = await getMacFromIp(clientIp);
        }
        if (mac === "UNKNOWN_MAC") {
            // Fallback: use IP-based ID for testing
            mac = `IP_${clientIp.replace(/\./g, '_')}`;
        }

        const wsId = await ensureWalletSet();
        const walletsRes = await circleClient.listWallets({ userId: mac });
        let wallet = walletsRes.data?.wallets?.find(
            w => w.blockchain === 'ARC-TESTNET' && w.walletSetId === wsId
        );

        if (!wallet) {
            const createRes = await circleClient.createWallets({
                idempotencyKey: uuidv5(mac, MAC_NAMESPACE),
                accountType: 'EOA',
                blockchains: ['ARC-TESTNET'],
                count: 1,
                userId: mac,
                walletSetId: wsId
            });
            wallet = createRes.data?.wallets?.[0];
        }

        // Get balances
        let balance = "0.00";
        let gatewayBalance = "0.00";
        try {
            const balRes = await circleClient.getWalletTokenBalance({ id: wallet.id });
            const usdc = balRes.data?.tokenBalances?.find(b =>
                b.token?.symbol?.includes('USDC')
            );
            balance = usdc ? usdc.amount : "0.00";

            const gBalRaw = await publicClient.readContract({
                address: getAddress(GATEWAY_CONTRACT),
                abi: [{
                    name: 'availableBalance',
                    type: 'function',
                    stateMutability: 'view',
                    inputs: [
                        { name: 'token', type: 'address' },
                        { name: 'depositor', type: 'address' }
                    ],
                    outputs: [{ name: '', type: 'uint256' }]
                }],
                functionName: 'availableBalance',
                args: [getAddress(USDC_ARC), getAddress(wallet.address)]
            });
            gatewayBalance = (Number(gBalRaw) / 1000000).toFixed(6);
        } catch (e) {
            // Balances might fail if wallet is new
        }

        // Store user data
        const existing = activeUsers.get(clientIp);
        activeUsers.set(clientIp, {
            ...existing,
            deviceId: mac,
            walletId: wallet.id,
            walletAddress: wallet.address,
            ip: clientIp,
            timestamp: Date.now(),
            status: existing?.status || 'identified'
        });

        res.json({
            success: true,
            deviceId: mac,
            address: wallet.address,
            walletId: wallet.id,
            balance,
            gatewayBalance
        });
    } catch (e) {
        console.error('Wallet identify error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Deposit to Gateway ---
app.post('/api/pay/deposit', async (req, res) => {
    try {
        const { walletId, amount = "0.5" } = req.body;
        if (!walletId) return res.status(400).json({ error: "walletId required" });

        // Get wallet address
        const walletsRes = await circleClient.listWallets({});
        const wallet = walletsRes.data?.wallets?.find(w => w.id === walletId);
        if (!wallet) return res.status(404).json({ error: "Wallet not found" });

        // Execute deposit to gateway contract
        const amountBaseUnits = BigInt(Math.floor(parseFloat(amount) * 1000000)).toString();

        const txRes = await circleClient.createContractExecutionTransaction({
            idempotencyKey: uuidv4(),
            walletId: walletId,
            contractAddress: USDC_ARC,
            abiFunctionSignature: "approve(address,uint256)",
            abiParameters: [getAddress(GATEWAY_CONTRACT), amountBaseUnits],
            fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }
        });

        logEvent('system', `Deposit approval tx: ${txRes.data?.transaction?.id}`);

        // After approval, deposit to gateway
        setTimeout(async () => {
            try {
                await circleClient.createContractExecutionTransaction({
                    idempotencyKey: uuidv4(),
                    walletId: walletId,
                    contractAddress: GATEWAY_CONTRACT,
                    abiFunctionSignature: "deposit(address,uint256)",
                    abiParameters: [getAddress(USDC_ARC), amountBaseUnits],
                    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }
                });
                logEvent('system', `Gateway deposit completed for ${walletId.slice(0,12)}`);
            } catch (e) {
                console.error('Deposit step 2 error:', e);
            }
        }, 8000);

        res.json({ success: true, txId: txRes.data?.transaction?.id });
    } catch (e) {
        console.error('Deposit error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- x402 Payment Flow ---
app.post('/api/access/unlock', async (req, res) => {
    try {
        const sigHeader = req.headers['payment-signature'];
        const { deviceId } = req.body;
        const clientIp = getClientIp(req);

        // PHASE 1: Challenge (no payment provided)
        if (!sigHeader) {
            const amountStr = (PRICE_PER_MB * MB_PER_PAYMENT).toFixed(6);

            const requirements = {
                scheme: "exact",
                network: "eip155:5042002",
                asset: USDC_ARC,
                amount: BigInt(Math.floor(parseFloat(amountStr) * 1000000)).toString(),
                payTo: getAddress(MERCHANT_WALLET),
                maxTimeoutSeconds: 345600,
                extra: {
                    name: "GatewayWalletBatched",
                    version: "1",
                    verifyingContract: getAddress(GATEWAY_CONTRACT),
                }
            };

            logEvent('system', `402 Challenge for ${clientIp} - $${amountStr} USDC for ${MB_PER_PAYMENT}MB`);

            const paymentRequired = {
                x402Version: 2,
                resource: {
                    url: '/api/access/unlock',
                    description: `${MB_PER_PAYMENT}MB Bandwidth Access`,
                    mimeType: 'application/octet-stream'
                },
                accepts: [requirements]
            };

            res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'));
            return res.status(402).json({
                error: "Payment Required",
                message: `Pay $${amountStr} USDC for ${MB_PER_PAYMENT}MB access`,
                requirements
            });
        }

        // PHASE 2: Verify & Settle
        console.log("Payment signature received, decoding...");
        const payload = JSON.parse(Buffer.from(sigHeader, 'base64').toString('utf-8'));

        // Build requirements for verification
        const amountStr = (PRICE_PER_MB * MB_PER_PAYMENT).toFixed(6);
        const requirements = {
            scheme: "exact",
            network: "eip155:5042002",
            asset: USDC_ARC,
            amount: BigInt(Math.floor(parseFloat(amountStr) * 1000000)).toString(),
            payTo: getAddress(MERCHANT_WALLET),
            maxTimeoutSeconds: 345600,
            extra: {
                name: "GatewayWalletBatched",
                version: "1",
                verifyingContract: getAddress(GATEWAY_CONTRACT),
            }
        };

        // The payload from the client is already in the correct x402 format
        // Pass it directly to verify/settle - no re-wrapping needed
        const paymentPayload = payload;

        // Verify
        console.log(`[x402] Verifying payment for ${clientIp}...`);
        const verify = await gateway.verify(paymentPayload, requirements);
        if (!verify.isValid) {
            console.error(`[x402] Verify FAILED for ${clientIp}:`, verify.invalidReason);
            if (verify.error) console.error("[x402] Error details:", verify.error);
            return res.status(402).json({ error: "Invalid payment", reason: verify.invalidReason });
        }

        // Settle
        console.log(`[x402] Verification success. Settling payment...`);
        const settle = await gateway.settle(paymentPayload, requirements);
        if (!settle.success) {
            console.error(`[x402] Settle FAILED for ${clientIp}:`, settle.errorReason);
            return res.status(500).json({ error: "Settlement failed", reason: settle.errorReason });
        }

        // Activate user
        const existing = activeUsers.get(clientIp);
        const mbLimit = MB_PER_PAYMENT;

        if (existing) {
            existing.mbLimit = (existing.mbLimit || 0) + mbLimit;
            existing.status = 'active';
        } else {
            activeUsers.set(clientIp, {
                deviceId,
                mbLimit,
                bytesUsed: 0,
                timestamp: Date.now(),
                status: 'active',
                walletAddress: payload.authorization?.from
            });
        }

        totalRevenue += parseFloat(amountStr);
        logEvent('payment', `Access granted to ${clientIp.slice(0,12)}... Tx: ${settle.transaction?.slice(0,20)}`);

        // Add iptables rules to grant internet access (no quota - Gateway balance is the real limit)
        if (process.platform !== 'win32') {
            // Remove any old rules for this IP
            exec(`sudo iptables -D PAYPERBYTE -s ${clientIp} -j ACCEPT 2>/dev/null`);
            exec(`sudo iptables -D PAYPERBYTE -d ${clientIp} -j ACCEPT 2>/dev/null`);
            exec(`sudo iptables -t nat -D PAYPERBYTE_NAT -s ${clientIp} -j RETURN 2>/dev/null`);
            // Grant full access (Gateway balance is enforced by Circle during verify)
            exec(`sudo iptables -I PAYPERBYTE 1 -s ${clientIp} -j ACCEPT 2>/dev/null`);
            exec(`sudo iptables -I PAYPERBYTE 1 -d ${clientIp} -j ACCEPT 2>/dev/null`);
            // Skip captive portal redirect for paid IP
            exec(`sudo iptables -t nat -I PAYPERBYTE_NAT 1 -s ${clientIp} -j RETURN 2>/dev/null`);
        }

        const responseData = {
            success: true,
            transaction: settle.transaction,
            mbGranted: mbLimit,
            expiresAt: new Date(Date.now() + 3600000).toISOString()
        };

        res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(responseData)).toString('base64'));
        res.json(responseData);

    } catch (e) {
        console.error('Access unlock error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Sign x402 Payment (Client-side helper) ---
app.post('/api/pay/sign-x402', async (req, res) => {
    try {
        const { deviceId, walletId, amount = PRICE_PER_MB } = req.body;

        const walletsRes = await circleClient.listWallets({ userId: deviceId });
        const userWallet = walletsRes.data?.wallets?.find(w => w.id === walletId);
        if (!userWallet) throw new Error("Wallet not found");

        const amountStr = (parseFloat(amount) * MB_PER_PAYMENT).toFixed(6);
        const amountBaseUnits = BigInt(Math.floor(parseFloat(amountStr) * 1000000)).toString();
        const nonce = toHex(uuidv4().replace(/-/g, ''), { size: 32 });
        const validBefore = Math.floor(Date.now() / 1000) + 345600; // 4 days (matches maxTimeoutSeconds)

        const typedData = {
            domain: {
                name: 'GatewayWalletBatched',
                version: '1',
                chainId: 5042002,
                verifyingContract: getAddress(GATEWAY_CONTRACT)
            },
            types: {
                EIP712Domain: [
                    { name: 'name', type: 'string' },
                    { name: 'version', type: 'string' },
                    { name: 'chainId', type: 'uint256' },
                    { name: 'verifyingContract', type: 'address' }
                ],
                TransferWithAuthorization: [
                    { name: 'from', type: 'address' },
                    { name: 'to', type: 'address' },
                    { name: 'value', type: 'uint256' },
                    { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                    { name: 'nonce', type: 'bytes32' }
                ]
            },
            primaryType: 'TransferWithAuthorization',
            message: {
                from: getAddress(userWallet.address),
                to: getAddress(MERCHANT_WALLET),
                value: amountBaseUnits,
                validAfter: "0",
                validBefore: validBefore.toString(),
                nonce: nonce
            }
        };

        const signRes = await circleClient.signTypedData({
            idempotencyKey: uuidv4(),
            walletAddress: getAddress(userWallet.address),
            blockchain: 'ARC-TESTNET',
            data: JSON.stringify(typedData)
        });

        // Build the requirements (must match what /api/access/unlock expects)
        const requirements = {
            scheme: "exact",
            network: "eip155:5042002",
            asset: USDC_ARC,
            amount: amountBaseUnits,
            payTo: getAddress(MERCHANT_WALLET),
            maxTimeoutSeconds: 345600,
            extra: {
                name: "GatewayWalletBatched",
                version: "1",
                verifyingContract: getAddress(GATEWAY_CONTRACT),
            }
        };

        // Build the FULL x402 payment payload that Circle Gateway expects
        const fullPayload = {
            x402Version: 2,
            resource: {
                url: '/api/access/unlock',
                description: `${MB_PER_PAYMENT}MB Bandwidth Access`,
                mimeType: 'application/octet-stream'
            },
            accepted: requirements,
            payload: {
                scheme: "GatewayWalletBatched",
                network: "eip155:5042002",
                authorization: typedData.message,
                signature: signRes.data?.signature
            }
        };

        res.json({
            payload: fullPayload,
            encoded: Buffer.from(JSON.stringify(fullPayload)).toString('base64')
        });
    } catch (e) {
        console.error('Sign x402 error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Usage ---
app.get('/api/usage/me', (req, res) => {
    const clientIp = getClientIp(req);
    const user = activeUsers.get(clientIp);
    if (!user) return res.json({ used: 0, limit: 0, percent: 0 });
    res.json({
        used: (user.bytesUsed / (1024 * 1024)).toFixed(2),
        limit: user.mbLimit,
        percent: ((user.bytesUsed / (user.mbLimit * 1024 * 1024)) * 100).toFixed(0)
    });
});

// --- Stats (for Dashboard) ---
app.get('/api/stats', (req, res) => {
    const totalSignatures = Array.from(activeUsers.values()).reduce((s, u) => s + (u.signaturesCount || 0), 0);
    res.json({
        totalRevenue: totalRevenue.toFixed(6),
        totalSignatures,
        activeConnections: activeUsers.size,
        connectedDevices: Array.from(activeUsers.entries()).map(([ip, data]) => ({
            ip,
            deviceId: data.deviceId?.slice(0, 16) + '...',
            mbUsed: ((data.bytesUsed || 0) / (1024 * 1024)).toFixed(2),
            mbLimit: data.mbLimit || 0,
            usage: `${((data.bytesUsed || 0) / (1024 * 1024)).toFixed(1)} / ${data.mbLimit || 0} MB`,
            progress: data.mbLimit ? ((data.bytesUsed / (data.mbLimit * 1024 * 1024)) * 100).toFixed(0) : '0',
            signaturesCount: data.signaturesCount || 0,
            totalPaid: (data.totalPaid || 0).toFixed(6),
            lastSignatureAt: data.lastSignatureAt || null,
            status: data.status || 'unknown'
        })),
        events: recentEvents,
        agent: agentStatus
    });
});

// --- Health Check ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', agent: agentStatus.state, users: activeUsers.size });
});

// ============================================================
// SPA FALLBACK (must be after all API routes)
// ============================================================
app.get('{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
    console.error("Global error:", err);
    res.status(500).json({ error: "Internal server error" });
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`
========================================
  PAYPERBYTE STATION v2.0
  Autonomous Bandwidth Agent
========================================
`);
    await ensureWalletSet();
    await setupWalledGarden();
    bandwidthAgent.start();
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/dashboard`);
});
