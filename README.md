# PayPerByte // Autonomous Bandwidth Marketplace

> A real-time bandwidth marketplace where an autonomous agent sells internet access per megabyte using USDC nanopayments.

## Hackathon Submission

**Event:** [Agentic Economy on Arc - Lablab.ai](https://lablab.ai/ai-hackathons/nano-payments-arc)

**Dates:** April 20-26, 2026

**Tracks:**
- **Per-API Monetization Engine** - Our `/api/access/unlock` endpoint charges per bandwidth allocation using USDC, demonstrating viable per-request pricing at high frequency via x402 nanopayments.
- **Agent-to-Agent Payment Loop** - The PayPerByte agent autonomously executes and verifies payments in real-time, proving machine-to-machine commerce without batching or custodial control.
- **Usage-Based Compute Billing** - The system charges per megabyte of bandwidth consumed, with real-time settlement aligned to actual usage via Circle's batched settlement.
- **Real-Time Micro-Commerce Flow** - Every internet access session triggers an economic activity that is settled per interaction, not per subscription, enabling true pay-as-you-go connectivity.

---

## What We Built

PayPerByte transforms internet access from a fixed monthly subscription into a **real-time economic primitive**. We built a programmable hotspot where machines pay for bandwidth as they use it, turning connectivity into a stream of nanopayments.

### Core Innovation

An **autonomous bandwidth agent** acts as an intermediary between network consumption and payment execution. It:

- **Monitors** bandwidth usage in real-time via `iptables`
- **Enforces** access control policies (blocks/quota management)
- **Executes** high-frequency nanopayments via Circle's x402 protocol
- **Auto-renews** quotas when users approach their limit
- **Settles** payments in bulk via Circle Gateway on Arc testnet

All without human intervention.

---

## Architecture

```
User Device (Phone/Laptop)
    |
    | HTTP Request
    v
+------------------+     +------------------+     +------------------+
|   Express API    |---->|  Circle Gateway  |---->|   Arc Testnet    |
|   (Port 3000)    |     |  (x402 Batching) |     |  (USDC Settlement) |
+------------------+     +------------------+     +------------------+
    |
    | iptables Rules
    v
+------------------+     +------------------+
|  Linux Router    |<--->|  Internet        |
|  (Bandwidth ctl) |     |  (Walled Garden) |
+------------------+     +------------------+
    ^
    |
+----------------------------------+
|  Autonomous Bandwidth Agent      |
|  - Monitors usage every 5s       |
|  - Auto-renews at 80% threshold  |
|  - Blocks when quota exceeded    |
|  - Executes EIP-712 signatures for EIP-3009 auths |
+----------------------------------+
```

### Components

| Component | File | Description |
|-----------|------|-------------|
| **API Server** | `server.js` | Express backend with x402 payment flow, wallet management, and agent orchestration |
| **Client Portal** | `src/App.tsx` | React app where users connect, deposit USDC, and purchase bandwidth |
| **Admin Dashboard** | `dashboard.html` | Real-time monitoring of revenue, users, bandwidth consumption, and agent actions |
| **Bandwidth Agent** | `server.js (BandwidthAgent class)` | Autonomous agent that monitors, enforces, and auto-renews |

---

## Technology Stack

- **Circle Nanopayments** - Gas-free USDC nanopayments via x402 protocol and batched settlement
- **Circle Developer Controlled Wallets** - Programmable wallets for users and merchant
- **x402 Protocol** - HTTP 402 Payment Required standard for payment negotiation
- **Arc Testnet** - EVM-compatible chain with sub-second finality for USDC settlement
- **EIP-712 / EIP-3009** - Typed data signing for off-chain EIP-3009 TransferWithAuthorization USDC payments
- **Express.js** - API server handling x402 challenges, verification, and settlement
- **React + Tailwind** - Client portal UI
- **iptables** - Linux kernel-level bandwidth control and access enforcement

---

## The Problem With Fixed Internet Pricing

Traditional ISPs sell bandwidth in monthly chunks. You pay $50 whether you use 1 GB or 1 TB. This creates:

- **Overpayment** - Light users subsidize heavy users
- **No granularity** - Can't sell/buy small amounts of connectivity
- **Barrier to entry** - Requires contracts, credit checks, human oversight
- **Inefficient for IoT** - Devices need flexible, machine-manageable access

### Our Solution

PayPerByte enables **per-megabyte internet access settled in real-time**:

- Pay $0.0038 USDC per 1 MB of data (EIP-3009 TransferWithAuthorization)
- Auto-renewal when you hit 80% usage
- No gas fees (Circle Gateway batched settlement)
- No contracts, no human intervention
- Machine-to-machine ready

---

## How It Works

### 1. Device Identification
When a user connects to the WiFi hotspot, the system:
- Detects their IP and resolves their MAC address
- Creates a Circle Developer Controlled Wallet on Arc testnet (if new)
- Returns wallet address, USDC balance, and Gateway credit balance

### 2. Gateway Deposit
Before accessing the internet, the user deposits USDC into Circle Gateway:
- Approves the Gateway contract to spend USDC
- Deposits into the batched settlement contract
- This enables gasless nanopayments

### 3. x402 Payment Flow
When the user clicks "Connect":

```
Client -> POST /api/access/unlock
Server <- 402 Payment Required + PAYMENT-REQUIRED header
Client -> POST /api/pay/sign-x402 (signs EIP-712 authorization)
Client -> POST /api/access/unlock + PAYMENT-SIGNATURE header
Server <- gateway.verify(payload, requirements)
Server <- gateway.settle(payload, requirements)
Server -> Internet access granted + iptables quota rule
```

### 4. Autonomous Agent Monitoring
While connected:
- Agent measures bandwidth via `iptables -L FORWARD -v -n -x` every 5 seconds
- When usage reaches **80%**, agent auto-renews by executing another nanopayment
- When usage reaches **100%**, agent blocks access via `iptables DROP`
- All agent actions are logged to the real-time event feed

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/wallet/identify` | Identify device & get/create wallet |
| `POST` | `/api/pay/deposit` | Deposit USDC to Circle Gateway |
| `POST` | `/api/pay/sign-x402` | Sign EIP-712 x402 payment authorization |
| `POST` | `/api/access/unlock` | Request internet access (x402 challenge/response) |
| `GET` | `/api/usage/me` | Get current bandwidth usage |
| `GET` | `/api/stats` | Get all stats for admin dashboard |
| `GET` | `/api/agent/status` | Get autonomous agent status |
| `GET` | `/dashboard` | Admin dashboard |

---

## Getting Started

### Prerequisites

- Node.js 20+
- Circle Developer account: https://console.circle.com
- Circle API Key and Entity Secret
- Merchant wallet address on Arc testnet
- (Optional) Linux system with iptables for full bandwidth control

### Environment Setup

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Fill in your credentials:
```env
CIRCLE_API_KEY=your_circle_api_key
ENTITY_SECRET=your_entity_secret
CIRCLE_WALLET_ADDRESS=your_merchant_wallet_address
```

3. Get test USDC from the Arc faucet: https://faucet.circle.com

### Installation

```bash
# Install dependencies
npm install

# Build the client portal
npm run build

# Start the server (serves API + static files)
npm start
```

The server will start on `http://0.0.0.0:3000`:
- **Client Portal:** http://localhost:3000
- **Admin Dashboard:** http://localhost:3000/dashboard

### Development Mode

```bash
# Run server + client with hot reload
npm run dev
```

Server runs on port 3000, client dev server on port 5173 with API proxy.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CIRCLE_API_KEY` | - | Circle API key |
| `ENTITY_SECRET` | - | Circle entity secret |
| `CIRCLE_WALLET_ADDRESS` | - | Merchant wallet address |
| `PRICE_PER_MB` | 0.0038 | USDC price per MB |
| `MB_PER_PAYMENT` | 1 | MB allocation per payment |
| `AUTO_RENEW_THRESHOLD` | 0.8 | Auto-renew at this % usage |
| `PORT` | 3000 | Server port |

---

## File Structure

```
.
├── server.js              # Express API + Autonomous Agent
├── dashboard.html         # Admin monitoring dashboard
├── .env.example           # Environment template
├── package.json           # Dependencies & scripts
├── index.html             # Vite entry point
├── vite.config.ts         # Vite build configuration
├── tailwind.config.js     # Tailwind CSS configuration
├── dist/                  # Built React app (served statically)
│   ├── index.html
│   └── assets/
└── src/
    ├── App.tsx            # Client portal (React)
    ├── App.css            # Portal styles
    ├── index.css          # Global styles
    └── main.tsx           # Entry point
```

---

## Why This Matters for the Agentic Economy

As AI agents become economic actors, they need:

1. **Granular payment rails** - Sub-cent transactions for compute, data, and services
2. **Autonomous execution** - No human approval for every payment
3. **Real-time settlement** - Immediate value transfer, not batching
4. **Gasless operation** - Fees shouldn't exceed the payment amount

PayPerByte demonstrates all four by enabling an autonomous agent to monetize a physical resource (bandwidth) through programmatic nanopayments.

---

## Team & Links

- **Repository:** https://github.com/JaDi03/PayPerByte_v2
- **Hackathon:** https://lablab.ai/ai-hackathons/nano-payments-arc
- **Circle Nanopayments:** https://developers.circle.com/gateway/nanopayments
- **x402 Protocol:** https://developers.circle.com/gateway/nanopayments/concepts/x402

---

## License

MIT
