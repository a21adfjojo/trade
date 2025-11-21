// server.js
// Single-file Node.js server for the game
// Requirements: node >=14, npm packages: express mongoose socket.io cors dotenv
//
// Install:
// npm init -y
// npm i express mongoose socket.io cors dotenv
//
// Run:
// MONGO_URL="mongodb+srv://user:pass@cluster/.../dbname?retryWrites=true&w=majority" node server.js

require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const cors = require("cors");
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// ---------- Schemas ----------
const CompanySchema = new mongoose.Schema({
  name: { type: String, unique: true },
  symbol: String,
  price: Number,
  volume: Number,
  sharesOutstanding: Number,
  fundamentals: {
    revenue: Number,
    profit: Number,
    rnd: Number,
  },
  volatility: { type: Number, default: 0.02 }, // base volatility
  orderBook: {
    buy: [{ price: Number, amount: Number }], // descending price
    sell: [{ price: Number, amount: Number }], // ascending price
  },
  lastUpdated: Date,
});

const NPCSchema = new mongoose.Schema({
  name: String,
  type: String, // short / long / trend
  funds: Number,
  holdings: Object,
});

const MarketSchema = new mongoose.Schema({
  interestRate: Number,
  lastPolicyEvent: Date,
});

const Company = mongoose.model("Company", CompanySchema);
const NPC = mongoose.model("NPC", NPCSchema);
const Market = mongoose.model("Market", MarketSchema);

// ---------- Utilities ----------
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function sortOrderBook(book) {
  book.buy.sort((a, b) => b.price - a.price || 0);
  book.sell.sort((a, b) => a.price - b.price || 0);
}

// Add order to company's in-memory book (persisted after)
function addOrderToBook(company, side, price, amount) {
  if (!company.orderBook) company.orderBook = { buy: [], sell: [] };
  if (side === "buy") {
    company.orderBook.buy.push({ price, amount });
  } else {
    company.orderBook.sell.push({ price, amount });
  }
  sortOrderBook(company.orderBook);
}

// Match orders in the company's book. Returns executed volume and last trade price.
function matchCompanyOrders(company) {
  const buy = company.orderBook.buy;
  const sell = company.orderBook.sell;
  let executedVolume = 0;
  let lastPrice = company.price;

  while (buy.length && sell.length && buy[0].price >= sell[0].price) {
    const dealPrice = (buy[0].price + sell[0].price) / 2; // midpoint
    const dealAmount = Math.min(buy[0].amount, sell[0].amount);

    // Apply trade
    lastPrice = dealPrice;
    executedVolume += dealAmount;
    company.volume = (company.volume || 0) + dealAmount;

    buy[0].amount -= dealAmount;
    sell[0].amount -= dealAmount;

    if (buy[0].amount <= 0) buy.shift();
    if (sell[0].amount <= 0) sell.shift();
  }

  company.price = clamp(lastPrice, 1, Number.MAX_SAFE_INTEGER);
  return { executedVolume, lastPrice };
}

// Compute order imbalance for company: (bidVolume - askVolume) / totalVolume
function computeImbalance(company) {
  const buyVol = (company.orderBook.buy || []).reduce(
    (s, o) => s + o.amount,
    0
  );
  const sellVol = (company.orderBook.sell || []).reduce(
    (s, o) => s + o.amount,
    0
  );
  const total = buyVol + sellVol;
  if (total === 0) return 0;
  return (buyVol - sellVol) / total;
}

// ---------- Initialization / Seeding ----------
async function initDB() {
  console.log("Checking DB initial data...");
  const companyCount = await Company.countDocuments();
  if (companyCount === 0) {
    console.log("Seeding companies...");
    const seed = [
      {
        name: "Aether Energy",
        symbol: "AEEN",
        price: 120,
        volume: 10000,
        sharesOutstanding: 100000,
        fundamentals: { revenue: 1000, profit: 120, rnd: 70 },
        volatility: 0.02,
        orderBook: { buy: [], sell: [] },
        lastUpdated: new Date(),
      },
      {
        name: "CrystalWorks",
        symbol: "CRWK",
        price: 80,
        volume: 8000,
        sharesOutstanding: 80000,
        fundamentals: { revenue: 600, profit: 60, rnd: 50 },
        volatility: 0.025,
        orderBook: { buy: [], sell: [] },
        lastUpdated: new Date(),
      },
      {
        name: "Logica Shipping",
        symbol: "LGSH",
        price: 45,
        volume: 5000,
        sharesOutstanding: 120000,
        fundamentals: { revenue: 400, profit: 30, rnd: 20 },
        volatility: 0.03,
        orderBook: { buy: [], sell: [] },
        lastUpdated: new Date(),
      },
      {
        name: "TerraFoods",
        symbol: "TRFD",
        price: 20,
        volume: 2000,
        sharesOutstanding: 50000,
        fundamentals: { revenue: 300, profit: 25, rnd: 10 },
        volatility: 0.035,
        orderBook: { buy: [], sell: [] },
        lastUpdated: new Date(),
      },
    ];
    await Company.insertMany(seed);
    console.log("Companies seeded.");
  }

  const npcCount = await NPC.countDocuments();
  if (npcCount === 0) {
    console.log("Seeding NPCs...");
    await NPC.insertMany([
      { name: "Falcon Trader", type: "short", funds: 50000, holdings: {} },
      { name: "Quiet Whale", type: "long", funds: 200000, holdings: {} },
      { name: "Ripple Mind", type: "trend", funds: 80000, holdings: {} },
    ]);
    console.log("NPCs seeded.");
  }

  const marketCount = await Market.countDocuments();
  if (marketCount === 0) {
    console.log("Seeding Market settings...");
    await Market.create({ interestRate: 1.0, lastPolicyEvent: null });
    console.log("Market seeded.");
  }

  console.log("DB ready.");
}

// ---------- API Endpoints ----------
app.get("/companies", async (req, res) => {
  const companies = await Company.find().lean();
  res.json({ companies });
});

// Fetch single company book
app.get("/orderbook/:symbol", async (req, res) => {
  const c = await Company.findOne({ symbol: req.params.symbol }).lean();
  if (!c) return res.status(404).json({ error: "not found" });
  res.json({ orderBook: c.orderBook || { buy: [], sell: [] } });
});

// Place order: { symbol, side: 'buy'|'sell', price, amount, user?:string }
// For simplicity there is no auth here; production must add JWT/auth.
app.post("/order", async (req, res) => {
  try {
    const { symbol, side, price, amount } = req.body;
    if (!symbol || !side || !price || !amount)
      return res.status(400).json({ error: "bad request" });
    const company = await Company.findOne({ symbol });
    if (!company) return res.status(404).json({ error: "company not found" });

    addOrderToBook(company, side, Number(price), Number(amount));
    matchCompanyOrders(company);
    await company.save();

    // Broadcast updated state
    await broadcastState();
    return res.json({ ok: true });
  } catch (err) {
    console.error("order error", err);
    res.status(500).json({ error: "server" });
  }
});

// simple health
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Market Mechanics ----------

// One market tick: compute realistic price shakes using multiple factors
async function marketTick() {
  const market = await Market.findOne();
  const companies = await Company.find();

  for (let company of companies) {
    // 1) Match orders first (already done on order entry and NPC orders) - re-run to be safe
    const m = matchCompanyOrders(company);

    // 2) Compute order imbalance effect
    const imbalance = computeImbalance(company); // -1..1
    const alpha = 0.6; // sensitivity to imbalance
    const imbalanceImpact = 1 + alpha * imbalance * 0.02; // small %

    // 3) Fundamentals drift (long-term tendency)
    const f = company.fundamentals || { revenue: 0, profit: 0, rnd: 0 };
    const fundScore =
      (f.profit + 0.6 * f.revenue + 0.4 * f.rnd) /
      Math.max(1, company.sharesOutstanding / 1000);
    const beta = 0.0005; // small drift factor
    const drift = 1 + beta * (fundScore - 1);

    // 4) interest effect: higher rates push price slightly down
    const interest = market ? market.interestRate : 1.0;
    const interestBias = 1 - (interest - 1.0) * 0.08; // if interest >1 => slight downward

    // 5) volatility & random noise scaled by volume and base volatility
    const baseVol = company.volatility || 0.02;
    const volScale = 1 + (company.volume || 0) / 20000; // higher volume -> higher instantaneous volatility
    const sigma = baseVol * volScale;
    // Gaussian-like noise approx: use Box-Muller
    const u1 = Math.random(),
      u2 = Math.random();
    const randStdNormal =
      Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const noiseFactor = 1 + randStdNormal * sigma * 0.5; // scale down

    // Combine multipliers
    let newPrice =
      company.price * imbalanceImpact * drift * interestBias * noiseFactor;

    // Prevent extreme jumps: clamp per-tick change to ±10%
    newPrice = company.price * clamp(newPrice / company.price, 0.9, 1.1);

    // Floor
    if (newPrice < 1) newPrice = 1;

    // Apply tiny micro moves if no changes to keep chart alive
    company.price = Number(newPrice.toFixed(4));
    company.lastUpdated = new Date();

    // persist
    await company.save();
  }

  // Broadcast state
  await broadcastState();
}

// Policy event generator: at most 1 per 24h; we check probability each full-day or each tick with gating
async function maybePolicyEvent() {
  const market = await Market.findOne();
  if (!market) return;
  const now = new Date();
  const last = market.lastPolicyEvent;
  if (last && now - last < 24 * 3600 * 1000) return; // already had event within 24h

  // small probability to trigger - tuned to roughly 1 event/day depending on tick frequency
  if (Math.random() < 0.12) {
    // change interest by -0.25 .. +0.25
    const delta = (Math.random() - 0.5) * 0.5;
    market.interestRate = clamp(market.interestRate + delta, 0.0, 10.0);
    market.lastPolicyEvent = now;
    await market.save();

    // Apply an immediate market-wide shock (random sign)
    const shockSign = Math.random() < 0.5 ? -1 : 1;
    const shockMag = 1 + Math.random() * 0.06 * shockSign; // ± up to ~6%

    const companies = await Company.find();
    for (let c of companies) {
      c.price = clamp(c.price * shockMag, 1, Number.MAX_SAFE_INTEGER);
      await c.save();
    }

    console.log("Policy event! new interestRate=", market.interestRate);
    io.emit("news", {
      type: "policy",
      text: `Policy event: interest changed to ${market.interestRate.toFixed(
        2
      )}`,
    });
    await broadcastState();
  }
}

// ---------- NPC behavior ----------
async function runNpcActions() {
  const npcs = await NPC.find();
  const companies = await Company.find();

  for (let npc of npcs) {
    // pick a random company
    const target = companies[Math.floor(Math.random() * companies.length)];
    if (!target) continue;
    // ensure holdings entry
    if (!npc.holdings) npc.holdings = {};

    // Behavior by type
    if (npc.type === "short") {
      // frequent small trades: buy at bid-1 or sell at ask+1
      if (Math.random() < 0.6) {
        // attempt buy
        const buyPrice = Math.max(
          1,
          Math.round((target.price - Math.random() * 2) * 100) / 100
        );
        const qty = Math.max(1, Math.floor(Math.random() * 5) + 1);
        addOrderToBook(target, "buy", buyPrice, qty);
        // naive funds reduce, holdings increase on matched trades only (we don't execute off-balance here)
      } else {
        const sellPrice =
          Math.round((target.price + Math.random() * 2) * 100) / 100;
        const qty = Math.max(1, Math.floor(Math.random() * 3));
        if ((npc.holdings[target.symbol] || 0) >= qty && qty > 0) {
          addOrderToBook(target, "sell", sellPrice, qty);
        }
      }
    } else if (npc.type === "long") {
      // occasional larger buys when cheap
      if (Math.random() < 0.12) {
        const buyPrice =
          Math.round(target.price * (0.98 + Math.random() * 0.05) * 100) / 100;
        const qty = Math.max(1, Math.floor(5 + Math.random() * 20));
        addOrderToBook(target, "buy", buyPrice, qty);
      }
    } else if (npc.type === "trend") {
      // follow momentum: if price rose recently buy, else maybe sell
      const momentum = Math.random() - 0.4; // small bias
      if (momentum > 0.2) {
        const buyPrice =
          Math.round((target.price + Math.random() * 1.5) * 100) / 100;
        const qty = Math.max(1, Math.floor(Math.random() * 5));
        addOrderToBook(target, "buy", buyPrice, qty);
      } else if (
        (npc.holdings[target.symbol] || 0) > 0 &&
        Math.random() < 0.2
      ) {
        const sellPrice =
          Math.round((target.price - Math.random() * 0.5) * 100) / 100;
        const qty = Math.max(
          1,
          Math.floor(Math.random() * (npc.holdings[target.symbol] || 1))
        );
        addOrderToBook(target, "sell", sellPrice, qty);
      }
    }

    // match orders for the selected company now to make NPC actions effective
    matchCompanyOrders(target);
    await target.save();
    await npc.save();
  }

  // After NPC batch, broadcast
  await broadcastState();
}

// ---------- Broadcast state to all clients ----------
let lastBroadcast = 0;
async function broadcastState(force = false) {
  const now = Date.now();
  // throttle to at most ~4x/sec if called redundantly
  if (!force && now - lastBroadcast < 200) return;
  lastBroadcast = now;

  const companies = await Company.find().lean();
  const market = await Market.findOne().lean();
  // send compacted orderbook top5 for each
  const compact = companies.map((c) => ({
    name: c.name,
    symbol: c.symbol,
    price: c.price,
    volume: c.volume,
    orderBook: {
      buy: c.orderBook && c.orderBook.buy ? c.orderBook.buy.slice(0, 8) : [],
      sell: c.orderBook && c.orderBook.sell ? c.orderBook.sell.slice(0, 8) : [],
    },
  }));
  io.emit("state", { companies: compact, market });
}

// ---------- Timers / loops ----------
async function startLoops() {
  // Fast loop: NPC actions and matching every 3s
  setInterval(async () => {
    try {
      await runNpcActions();
    } catch (err) {
      console.error("NPC loop err", err);
    }
  }, 3000);

  // Market tick every 5s for price updates
  setInterval(async () => {
    try {
      await marketTick();
    } catch (err) {
      console.error("marketTick err", err);
    }
  }, 5000);

  // Policy event check every 10s (itself gated to 1/day)
  setInterval(async () => {
    try {
      await maybePolicyEvent();
    } catch (err) {
      console.error("policyEvent err", err);
    }
  }, 10000);
}

// ---------- Socket.io ----------
io.on("connection", (socket) => {
  console.log("client connected", socket.id);
  // Send initial state once
  (async () => {
    await broadcastState(true);
  })();

  socket.on("placeOrder", async (data) => {
    // data: { symbol, side, price, amount }
    try {
      const { symbol, side, price, amount } = data;
      const company = await Company.findOne({ symbol });
      if (!company) return socket.emit("err", "company not found");
      addOrderToBook(company, side, Number(price), Number(amount));
      matchCompanyOrders(company);
      await company.save();
      await broadcastState();
    } catch (err) {
      console.error("socket placeOrder err", err);
    }
  });

  socket.on("disconnect", () => {
    //console.log('client disconnected', socket.id);
  });
});

// ---------- Start server ----------
async function start() {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("Please set MONGO_URL env var");
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected to MongoDB");
    await initDB();
    await startLoops();

    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
  } catch (err) {
    console.error("Startup error", err);
    process.exit(1);
  }
}

start();
