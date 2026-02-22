import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════
// MT5ScalpBridge.js
// Connects Node.js ScalpEngine → MT5 via file-based IPC
// MT5 EA reads signal files and executes trades automatically
//
// HOW IT WORKS:
// 1. Node writes signal to: MT5_SIGNALS_DIR/signal_{symbol}.json
// 2. MT5 EA watches that folder every tick
// 3. EA executes trade, writes result to: MT5_SIGNALS_DIR/result_{symbol}.json
// 4. Node reads result, updates WinRateTracker
// ═══════════════════════════════════════════════════════════════

export class MT5ScalpBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.signalsDir  = options.signalsDir  || process.env.MT5_SIGNALS_DIR || '/tmp/mt5_scalp_signals';
    this.riskPercent = options.riskPercent || parseFloat(process.env.MT5_RISK_PERCENT) || 1.0; // 1% per trade
    this.enabled     = options.enabled     ?? (process.env.MT5_AUTO_TRADE === 'true');
    this.pollMs      = options.pollMs      || 2000;  // check results every 2s
    this.pending     = {};  // { symbol: { signalId, sentAt } }
    this._poller     = null;

    if (this.enabled) {
      fs.mkdirSync(this.signalsDir, { recursive: true });
      console.log(`🤖 MT5 Auto-Trade: ENABLED`);
      console.log(`   Signals dir: ${this.signalsDir}`);
      console.log(`   Risk per trade: ${this.riskPercent}%`);
      this._startPoller();
    } else {
      console.log(`🤖 MT5 Auto-Trade: DISABLED (set MT5_AUTO_TRADE=true to enable)`);
    }
  }

  // ── SEND SIGNAL TO MT5 ──
  sendSignal(trade) {
    if (!this.enabled) return false;

    const signalId = `${trade.symbol}_${Date.now()}`;
    const symbolClean = trade.symbol.replace('/', ''); // XAU/USD → XAUUSD

    const signal = {
      id:           signalId,
      symbol:       symbolClean,          // MT5 format
      action:       trade.action,         // 'SELL'
      entryPrice:   trade.entryPrice,
      sl:           trade.sl,
      tp:           trade.tp,
      riskPercent:  this.riskPercent,     // EA calculates lot size from this
      rr:           trade.rr,
      confidence:   trade.confidence,
      reasons:      trade.reasons,
      timestamp:    new Date().toISOString(),
      expire:       new Date(Date.now() + 60000).toISOString(), // signal expires in 60s
    };

    const signalPath = path.join(this.signalsDir, `signal_${symbolClean}.json`);
    try {
      fs.writeFileSync(signalPath, JSON.stringify(signal, null, 2));
      this.pending[trade.symbol] = { signalId, sentAt: Date.now() };
      console.log(`📤 MT5 Signal sent: ${trade.action} ${symbolClean} @ ${trade.entryPrice?.toFixed(2)}`);
      console.log(`   SL: ${trade.sl?.toFixed(2)} | TP: ${trade.tp?.toFixed(2)} | Risk: ${this.riskPercent}%`);
      this.emit('signal_sent', signal);
      return true;
    } catch (err) {
      console.error(`❌ MT5 signal write failed:`, err.message);
      return false;
    }
  }

  // ── POLL FOR MT5 RESULTS ──
  _startPoller() {
    this._poller = setInterval(() => {
      try {
        const files = fs.readdirSync(this.signalsDir).filter(f => f.startsWith('result_'));
        for (const file of files) {
          const resultPath = path.join(this.signalsDir, file);
          try {
            const raw    = fs.readFileSync(resultPath, 'utf8');
            const result = JSON.parse(raw);
            this._handleResult(result);
            fs.unlinkSync(resultPath); // delete after reading
          } catch { /* skip malformed */ }
        }
      } catch { /* dir might not exist yet */ }
    }, this.pollMs);
  }

  _handleResult(result) {
    console.log(`\n📥 MT5 Result received:`);
    console.log(`   Symbol: ${result.symbol} | Ticket: ${result.ticket}`);
    console.log(`   Status: ${result.status} | Entry: ${result.entryPrice} | Close: ${result.closePrice}`);
    console.log(`   P&L: ${result.pnl} ${result.currency} | R: ${result.rPnL}`);
    this.emit('trade_result', result);
  }

  stop() {
    if (this._poller) clearInterval(this._poller);
  }
}

// ═══════════════════════════════════════════════════════════════
// MT5 EA CODE (MQL5) — paste this into MetaEditor
// File: ScalpBridgeEA.mq5
// ═══════════════════════════════════════════════════════════════
export const MT5_EA_CODE = `
//+------------------------------------------------------------------+
//| ScalpBridgeEA.mq5 — Auto-executes signals from Node.js           |
//| Place in: MT5/MQL5/Experts/                                       |
//+------------------------------------------------------------------+
#property copyright "ScalpAgent"
#property version   "1.00"

#include <Trade\\Trade.mqh>

// ── INPUTS ──
input string   SignalsFolder = "C:\\\\mt5_scalp_signals\\\\"; // match MT5_SIGNALS_DIR
input double   RiskPercent   = 1.0;   // % of balance per trade (overridden by signal)
input int      MagicNumber   = 88888;
input int      MaxSlippage   = 30;    // points

CTrade trade;
string lastSignalId = "";

//+------------------------------------------------------------------+
int OnInit() {
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(MaxSlippage);
   Print("ScalpBridgeEA started. Watching: ", SignalsFolder);
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
void OnTick() {
   string symbol = Symbol();
   string signalFile = SignalsFolder + "signal_" + symbol + ".json";

   // Read signal file if it exists
   if(!FileIsExist(signalFile, FILE_COMMON)) return;

   int handle = FileOpen(signalFile, FILE_READ|FILE_TXT|FILE_COMMON);
   if(handle == INVALID_HANDLE) return;

   string content = "";
   while(!FileIsEnding(handle)) content += FileReadString(handle);
   FileClose(handle);

   // Simple JSON parsing (key fields only)
   string signalId  = JsonExtract(content, "id");
   string action    = JsonExtract(content, "action");
   string expireStr = JsonExtract(content, "expire");
   double sl        = StringToDouble(JsonExtract(content, "sl"));
   double tp        = StringToDouble(JsonExtract(content, "tp"));
   double riskPct   = StringToDouble(JsonExtract(content, "riskPercent"));

   // Skip if already processed
   if(signalId == lastSignalId) return;

   // Check signal expiry
   datetime expire = StringToTime(expireStr);
   if(TimeCurrent() > expire) {
      Print("Signal expired, skipping: ", signalId);
      FileDelete(signalFile, FILE_COMMON);
      lastSignalId = signalId;
      return;
   }

   // Skip if already have open position for this symbol
   if(PositionSelect(symbol)) {
      Print("Already in position, skipping signal");
      FileDelete(signalFile, FILE_COMMON);
      lastSignalId = signalId;
      return;
   }

   // Calculate lot size from risk %
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmt  = balance * riskPct / 100.0;
   double slPips   = MathAbs(SymbolInfoDouble(symbol, SYMBOL_ASK) - sl) / _Point / 10;
   double tickVal  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double lotSize  = NormalizeDouble(riskAmt / (slPips * tickVal), 2);
   lotSize = MathMax(lotSize, SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN));
   lotSize = MathMin(lotSize, SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX));

   // Execute trade
   bool success = false;
   if(action == "SELL") {
      success = trade.Sell(lotSize, symbol, 0, sl, tp, "ScalpAgent");
   } else if(action == "BUY") {
      success = trade.Buy(lotSize, symbol, 0, sl, tp, "ScalpAgent");
   }

   // Write result file
   int ticket = (int)trade.ResultOrder();
   double entry = trade.ResultPrice();
   string status = success ? "OPENED" : "FAILED";
   string errMsg = success ? "" : IntegerToString(trade.ResultRetcode());

   string result = "{";
   result += "\\"symbol\\": \\"" + symbol + "\\", ";
   result += "\\"ticket\\": " + IntegerToString(ticket) + ", ";
   result += "\\"status\\": \\"" + status + "\\", ";
   result += "\\"entryPrice\\": " + DoubleToString(entry, 5) + ", ";
   result += "\\"lotSize\\": " + DoubleToString(lotSize, 2) + ", ";
   result += "\\"sl\\": " + DoubleToString(sl, 5) + ", ";
   result += "\\"tp\\": " + DoubleToString(tp, 5) + ", ";
   result += "\\"error\\": \\"" + errMsg + "\\", ";
   result += "\\"closePrice\\": 0, \\"pnl\\": 0, \\"currency\\": \\"USD\\", \\"rPnL\\": 0";
   result += "}";

   string resultFile = SignalsFolder + "result_" + symbol + ".json";
   int rHandle = FileOpen(resultFile, FILE_WRITE|FILE_TXT|FILE_COMMON);
   if(rHandle != INVALID_HANDLE) {
      FileWriteString(rHandle, result);
      FileClose(rHandle);
   }

   FileDelete(signalFile, FILE_COMMON);
   lastSignalId = signalId;

   if(success) Print("✅ Trade executed: ", action, " ", lotSize, " lots @ ", entry);
   else Print("❌ Trade failed: ", trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
string JsonExtract(string json, string key) {
   string search = "\\"" + key + "\\"";
   int pos = StringFind(json, search);
   if(pos < 0) return "";
   pos = StringFind(json, ":", pos) + 1;
   while(StringGetCharacter(json, pos) == ' ') pos++;

   bool isString = StringGetCharacter(json, pos) == '"';
   if(isString) pos++;

   string val = "";
   for(int i = pos; i < StringLen(json); i++) {
      ushort ch = StringGetCharacter(json, i);
      if(isString && ch == '"') break;
      if(!isString && (ch == ',' || ch == '}' || ch == ' ')) break;
      val += ShortToString(ch);
   }
   return val;
}
`;