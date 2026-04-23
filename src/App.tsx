import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Wifi,
  Loader2,
  CheckCircle2,
  Shield,
  Zap,
  Smartphone,
  Globe,
  CreditCard,
  Activity,
  Lock,
  Unlock,
  RefreshCw,
  Signal
} from 'lucide-react';
import './App.css';

type Step = 'identifying' | 'dashboard' | 'online' | 'depositing';

interface UsageData {
  used: string;
  limit: number;
  percent: string;
}

interface WalletData {
  deviceId: string;
  address: string;
  walletId: string;
  balance: string;
  gatewayBalance: string;
}

function App() {
  const [step, setStep] = useState<Step>('identifying');
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [usage, setUsage] = useState<UsageData>({ used: '0', limit: 0, percent: '0' });
  const [loading, setLoading] = useState(false);
  const [depositAmount, setDepositAmount] = useState('0.5');
  const [txHistory, setTxHistory] = useState<Array<{id: string, type: string, time: string}>>([]);
  const [error, setError] = useState('');
  const [connectionQuality, setConnectionQuality] = useState(95);

  const api = axios.create({
    baseURL: '',
    headers: { 'Content-Type': 'application/json' }
  });

  // 1. Identify device on load
  useEffect(() => {
    identifyDevice();
  }, []);

  // 2. Poll usage when online
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (step === 'online') {
      interval = setInterval(async () => {
        try {
          const res = await api.get('/api/usage/me');
          setUsage(res.data);

          // Auto-renew when approaching limit
          if (parseFloat(res.data.percent) > 75 && parseFloat(res.data.percent) < 85) {
            addTx('renewal', 'Auto-renewal triggered...');
          }

          // Simulate connection quality variation
          setConnectionQuality(90 + Math.floor(Math.random() * 10));
        } catch (e) {
          console.error('Usage poll failed:', e);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [step]);

  async function identifyDevice() {
    try {
      setLoading(true);
      const res = await api.get('/api/wallet/identify');
      if (res.data.success) {
        setWallet(res.data);
        setStep('dashboard');
      }
    } catch (e: any) {
      setError('Failed to identify device: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  }

  async function handleDeposit() {
    if (!wallet) return;
    try {
      setLoading(true);
      setStep('depositing');
      const res = await api.post('/api/pay/deposit', {
        walletId: wallet.walletId,
        amount: depositAmount
      });
      if (res.data.success) {
        addTx('deposit', `Deposited ${depositAmount} USDC`);
        // Refresh balances after delay
        setTimeout(async () => {
          const idRes = await api.get('/api/wallet/identify');
          if (idRes.data.success) {
            setWallet(idRes.data);
          }
          setStep('dashboard');
        }, 12000);
      }
    } catch (e: any) {
      setError('Deposit failed: ' + (e.response?.data?.error || e.message));
      setStep('dashboard');
    }
  }

  async function handleBuy() {
    if (!wallet) return;
    try {
      setLoading(true);
      setError('');

      // Step 1: Attempt access (will get 402)
      try {
        await api.post('/api/access/unlock', { deviceId: wallet.deviceId });
      } catch (err: any) {
        if (err.response?.status === 402) {
          // Step 2: Get payment requirements from 402 response
          const requirements = err.response.data?.requirements;
          if (!requirements) throw new Error('No requirements in 402 response');

          // Step 3: Sign x402 payment
          const signRes = await api.post('/api/pay/sign-x402', {
            deviceId: wallet.deviceId,
            walletId: wallet.walletId,
            amount: parseFloat(requirements.amount) / 1000000
          });

          // Step 4: Retry with PAYMENT-SIGNATURE header
          const payloadB64 = signRes.data.encoded || btoa(JSON.stringify(signRes.data.payload));
          const finalRes = await api.post('/api/access/unlock',
            { deviceId: wallet.deviceId },
            { headers: { 'PAYMENT-SIGNATURE': payloadB64 } }
          );

          if (finalRes.data.success) {
            addTx('payment', `Paid for data - Tx: ${finalRes.data.transaction?.slice(0, 16)}...`);
            setStep('online');
          }
        } else {
          throw err;
        }
      }
    } catch (e: any) {
      setError('Payment failed: ' + (e.response?.data?.error || e.message));
    } finally {
      setLoading(false);
    }
  }

  const addTx = useCallback((type: string, message: string) => {
    setTxHistory(prev => [{ id: Date.now().toString(), type, time: new Date().toLocaleTimeString() + ' - ' + message }, ...prev].slice(0, 10));
  }, []);

  const formatAddress = (addr: string) => addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : '';

  // ===================== RENDER =====================

  if (step === 'identifying' || (step === 'depositing' && loading)) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-sm w-full text-center space-y-6">
          <div className="relative mx-auto w-20 h-20">
            <div className="absolute inset-0 rounded-full border-4 border-cyan-500/20" />
            <div className="absolute inset-0 rounded-full border-4 border-t-cyan-400 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
            <Smartphone className="absolute inset-0 m-auto w-8 h-8 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-white">PayPerByte</h1>
            <p className="text-slate-400 text-sm mt-2">
              {step === 'identifying' ? 'Identifying your device...' : 'Processing deposit...'}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
            <Shield className="w-3 h-3 text-green-400" />
            <span>Secured by Circle Nanopayments</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col">
      {/* Header */}
      <header className="bg-slate-900/80 backdrop-blur border-b border-slate-800 sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-black tracking-tight">PayPerByte</h1>
              <p className="text-[10px] text-slate-400 uppercase tracking-wider">Bandwidth Marketplace</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Signal className="w-3 h-3 text-green-400" />
            <span className="text-[10px] text-slate-400">ARC Testnet</span>
          </div>
        </div>
      </header>

      {/* Error Toast */}
      {error && (
        <div className="max-w-lg mx-auto w-full px-4 mt-4">
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 flex items-start gap-2">
            <Lock className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300">{error}</p>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 max-w-lg mx-auto w-full px-4 py-6 space-y-4">

        {/* Wallet Card */}
        {wallet && (
          <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">My Wallet</span>
              <span className="text-[10px] font-mono text-slate-500">{formatAddress(wallet.address)}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-800/50 rounded-xl p-3">
                <p className="text-[10px] text-cyan-400 uppercase tracking-wider font-semibold mb-1">USDC Balance</p>
                <p className="text-lg font-black font-mono">${parseFloat(wallet.balance).toFixed(4)}</p>
              </div>
              <div className="bg-slate-800/50 rounded-xl p-3">
                <p className="text-[10px] text-amber-400 uppercase tracking-wider font-semibold mb-1">Gateway Credit</p>
                <p className="text-lg font-black font-mono text-amber-400">${parseFloat(wallet.gatewayBalance).toFixed(4)}</p>
              </div>
            </div>
          </div>
        )}

        {/* Step: Dashboard */}
        {step === 'dashboard' && wallet && (
          <>
            {/* No Gateway Credit -> Need Deposit */}
            {parseFloat(wallet.gatewayBalance) < 0.001 ? (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
                <div className="text-center space-y-2">
                  <div className="w-14 h-14 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto">
                    <CreditCard className="w-7 h-7 text-amber-400" />
                  </div>
                  <h2 className="text-lg font-bold">Load Gateway Credit</h2>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Deposit USDC to the Circle Gateway to enable real-time nanopayments for bandwidth.
                  </p>
                </div>

                <div className="flex gap-2">
                  {['0.1', '0.5', '1.0'].map(amt => (
                    <button
                      key={amt}
                      onClick={() => setDepositAmount(amt)}
                      className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                        depositAmount === amt
                          ? 'bg-cyan-500 text-slate-900'
                          : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      {amt} USDC
                    </button>
                  ))}
                </div>

                <button
                  onClick={handleDeposit}
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-amber-500 to-orange-500 text-slate-900 font-black py-3.5 rounded-xl shadow-lg active:scale-[0.98] transition-all uppercase text-sm tracking-tight"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Processing...
                    </span>
                  ) : (
                    `Deposit ${depositAmount} USDC`
                  )}
                </button>

                <p className="text-[10px] text-slate-500 text-center">
                  Requires on-chain confirmation (~10s on ARC testnet)
                </p>
              </div>
            ) : (
              /* Has Credit -> Show Buy Button */
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold">Data Package</h2>
                    <p className="text-xs text-slate-400">Pay-as-you-go internet access</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-black text-cyan-400">{MB_PER_PAYMENT} MB</p>
                    <p className="text-xs text-slate-400">${(PRICE_PER_MB * MB_PER_PAYMENT).toFixed(4)} USDC</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-slate-800/30 rounded-lg p-2">
                    <Globe className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                    <p className="text-[10px] text-slate-400">Full Internet</p>
                  </div>
                  <div className="bg-slate-800/30 rounded-lg p-2">
                    <Zap className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                    <p className="text-[10px] text-slate-400">Instant</p>
                  </div>
                  <div className="bg-slate-800/30 rounded-lg p-2">
                    <Shield className="w-4 h-4 text-cyan-400 mx-auto mb-1" />
                    <p className="text-[10px] text-slate-400">Gasless</p>
                  </div>
                </div>

                <button
                  onClick={handleBuy}
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 font-black py-4 rounded-xl shadow-xl active:scale-[0.98] transition-all text-lg"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin" /> Processing...
                    </span>
                  ) : (
                    <span className="flex items-center justify-center gap-2">
                      <Unlock className="w-5 h-5" /> Connect Now
                    </span>
                  )}
                </button>

                <p className="text-[10px] text-slate-500 text-center">
                  Powered by x402 nanopayments on Circle Gateway
                </p>
              </div>
            )}
          </>
        )}

        {/* Step: Online */}
        {step === 'online' && (
          <div className="space-y-4">
            {/* Status Card */}
            <div className="bg-slate-900 rounded-2xl border border-green-500/20 p-5 text-center space-y-3">
              <div className="relative w-24 h-24 mx-auto">
                <div className="absolute inset-0 rounded-full border-4 border-green-500/10" />
                <div className="absolute inset-0 rounded-full border-4 border-t-green-500 border-r-transparent border-b-transparent border-l-transparent animate-[spin_3s_linear_infinite]" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Wifi className="w-10 h-10 text-green-400" />
                </div>
              </div>
              <div>
                <h2 className="text-2xl font-black italic text-white">CONNECTED</h2>
                <p className="text-xs text-green-400 uppercase tracking-widest font-semibold mt-1">Session Active & Secured</p>
              </div>
              <div className="flex items-center justify-center gap-4 text-xs">
                <span className="flex items-center gap-1 text-slate-400">
                  <Signal className="w-3 h-3" /> {connectionQuality}%
                </span>
                <span className="flex items-center gap-1 text-slate-400">
                  <Activity className="w-3 h-3" /> Nanopayments Active
                </span>
              </div>
            </div>

            {/* Usage Meter */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Data Consumed</span>
                <span className="text-sm font-black text-green-400">{usage.used} / {usage.limit} MB</span>
              </div>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all duration-500 ease-out"
                  style={{ width: `${Math.min(parseFloat(usage.percent), 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-slate-500">
                <span>{usage.percent}% used</span>
                <span>Auto-renews at 80%</span>
              </div>
            </div>

            {/* Agent Status */}
            <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4">
              <div className="flex items-center gap-2 mb-3">
                <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin" />
                <span className="text-[10px] text-cyan-400 uppercase tracking-wider font-semibold">Autonomous Agent Active</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                The PayPerByte agent is monitoring your consumption in real-time. When you reach 80% usage, it will automatically execute a nanopayment to renew your quota.
              </p>
            </div>

            {/* Transaction History */}
            {txHistory.length > 0 && (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 p-4 space-y-2">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Recent Activity</span>
                {txHistory.map(tx => (
                  <div key={tx.id} className="flex items-center gap-2 text-xs py-1 border-b border-slate-800/50 last:border-0">
                    <CheckCircle2 className="w-3 h-3 text-green-400 shrink-0" />
                    <span className="text-slate-300 flex-1">{tx.time}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Back Button */}
            <button
              onClick={() => setStep('dashboard')}
              className="w-full bg-white/5 hover:bg-white/10 text-slate-400 font-semibold py-3 rounded-xl transition-all border border-white/5 text-sm"
            >
              Back to Dashboard
            </button>
          </div>
        )}

        {/* Footer Info */}
        <div className="text-center pt-4 pb-8 space-y-2">
          <div className="flex items-center justify-center gap-2 text-[10px] text-slate-600">
            <Shield className="w-3 h-3" />
            <span>x402 Protocol</span>
            <span className="text-slate-700">|</span>
            <span>Circle Gateway</span>
            <span className="text-slate-700">|</span>
            <span>Arc Network</span>
          </div>
          <p className="text-[10px] text-slate-700">
            Built for Agentic Economy Hackathon
          </p>
        </div>
      </main>
    </div>
  );
}

// Constants
const MB_PER_PAYMENT = 1;
const PRICE_PER_MB = 0.0038;

export default App;
