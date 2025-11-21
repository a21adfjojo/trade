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
app.use(express.static(__dirname));

// ---------- Schemas ----------
const CompanySchema = new mongoose.Schema({
  name: { type: String, unique: true },
  symbol: String,
  price: Number,
  volume: Number,
  sharesOutstanding: Number,
  fundamentals: { revenue: Number, profit: Number, rnd: Number },
  volatility: { type: Number, default: 0.02 },
  orderBook: { buy: [], sell: [] },
  lastUpdated: Date,
});

const NPCSchema = new mongoose.Schema({
  name: String,
  type: String,
  funds: Number,
  holdings: Object,
});

const MarketSchema = new mongoose.Schema({
  interestRate: Number,
  lastPolicyEvent: Date,
});

const UserSchema = new mongoose.Schema({
  ip: { type: String, unique: true },
  balance: { type: Number, default: 100000 },
  holdings: { type: Object, default: {} },
  learningMode: { type: Boolean, default: true },
});

const Company = mongoose.model("Company", CompanySchema);
const NPC = mongoose.model("NPC", NPCSchema);
const Market = mongoose.model("Market", MarketSchema);
const User = mongoose.model("User", UserSchema);

// ---------- Utilities ----------
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function sortOrderBook(book) {
  book.buy.sort((a, b) => b.price - a.price);
  book.sell.sort((a, b) => a.price - b.price);
}
function addOrderToBook(
  company,
  side,
  price,
  amount,
  userId = null,
  type = "limit",
  stopPrice = null
) {
  if (!company.orderBook) company.orderBook = { buy: [], sell: [] };
  const order = { price, amount, userId, type, stopPrice, created: Date.now() };
  if (side === "buy") company.orderBook.buy.push(order);
  else company.orderBook.sell.push(order);
  sortOrderBook(company.orderBook);
}
function matchCompanyOrders(company) {
  const buy = company.orderBook.buy;
  const sell = company.orderBook.sell;
  let lastPrice = company.price;
  const trades = []; // ここに約定情報を保存

  while (buy.length && sell.length && buy[0].price >= sell[0].price) {
    const dealPrice = (buy[0].price + sell[0].price) / 2;
    const dealAmount = Math.min(buy[0].amount, sell[0].amount);
    lastPrice = dealPrice;
    company.volume = (company.volume || 0) + dealAmount;

    const trade = {
      symbol: company.symbol,
      price: dealPrice,
      amount: dealAmount,
      buyUserId: buy[0].userId,
      sellUserId: sell[0].userId,
      timestamp: new Date(),
    };
    trades.push(trade);

    io.emit("trade", trade);

    buy[0].amount -= dealAmount;
    sell[0].amount -= dealAmount;

    if (buy[0].amount <= 0) buy.shift();
    if (sell[0].amount <= 0) sell.shift();
  }

  company.price = clamp(lastPrice, 1, Number.MAX_SAFE_INTEGER);
  return trades; // ← 約定情報を返す
}

function computeImbalance(company) {
  const buyVol = (company.orderBook.buy || []).reduce(
    (s, o) => s + o.amount,
    0
  );
  const sellVol = (company.orderBook.sell || []).reduce(
    (s, o) => s + o.amount,
    0
  );
  if (buyVol + sellVol === 0) return 0;
  return (buyVol - sellVol) / (buyVol + sellVol);
}

// ---------- DB Initialization ----------
async function initDB() {
  if ((await Company.countDocuments()) === 0) {
    await Company.insertMany([
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
    ]);
  }
  if ((await NPC.countDocuments()) === 0) {
    await NPC.insertMany([
      { name: "Falcon Trader", type: "short", funds: 50000, holdings: {} },
      { name: "Quiet Whale", type: "long", funds: 200000, holdings: {} },
      { name: "Ripple Mind", type: "trend", funds: 80000, holdings: {} },
    ]);
  }
  if ((await Market.countDocuments()) === 0) {
    await Market.create({ interestRate: 1.0, lastPolicyEvent: null });
  }
}

// ---------- Market Tick ----------
async function marketTick() {
  const market = await Market.findOne();
  const companies = await Company.find();
  for (let company of companies) {
    matchCompanyOrders(company);
    const imbalance = computeImbalance(company);
    const alpha = 0.6;
    const imbalanceImpact = 1 + alpha * imbalance * 0.02;
    const f = company.fundamentals || { revenue: 0, profit: 0, rnd: 0 };
    const fundScore =
      (f.profit + 0.6 * f.revenue + 0.4 * f.rnd) /
      Math.max(1, company.sharesOutstanding / 1000);
    const drift = 1 + 0.0005 * (fundScore - 1);
    const interestBias = 1 - ((market?.interestRate || 1) - 1.0) * 0.08;
    const baseVol = company.volatility || 0.02;
    const volScale = 1 + (company.volume || 0) / 20000;
    const u1 = Math.random(),
      u2 = Math.random();
    const randStdNormal =
      Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const noiseFactor = 1 + randStdNormal * baseVol * volScale * 0.5;
    let newPrice =
      company.price * imbalanceImpact * drift * interestBias * noiseFactor;
    newPrice = company.price * clamp(newPrice / company.price, 0.9, 1.1);
    if (newPrice < 1) newPrice = 1;
    // 株価計算
    const updatedFields = {
      price: Number(newPrice.toFixed(4)),
      volume: company.volume,
      orderBook: company.orderBook,
      lastUpdated: new Date(),
    };
    await Company.findOneAndUpdate(
      { _id: company._id },
      { $set: updatedFields }
    );
  }
  await broadcastState();
}

// ---------- NPC ----------
async function runNpcActions() {
  const npcs = await NPC.find();
  const companies = await Company.find();
  for (let npc of npcs) {
    const target = companies[Math.floor(Math.random() * companies.length)];
    if (!npc.holdings) npc.holdings = {};
    if (npc.type === "short") {
      if (Math.random() < 0.6)
        addOrderToBook(
          target,
          "buy",
          Math.max(
            1,
            Math.round((target.price - Math.random() * 2) * 100) / 100
          ),
          Math.floor(Math.random() * 5) + 1
        );
      else {
        const qty = Math.max(1, Math.floor(Math.random() * 3));
        if ((npc.holdings[target.symbol] || 0) >= qty)
          addOrderToBook(
            target,
            "sell",
            Math.round((target.price + Math.random() * 2) * 100) / 100,
            qty
          );
      }
    } else if (npc.type === "long") {
      if (Math.random() < 0.12)
        addOrderToBook(
          target,
          "buy",
          Math.round(target.price * (0.98 + Math.random() * 0.05) * 100) / 100,
          Math.floor(5 + Math.random() * 20)
        );
    } else if (npc.type === "trend") {
      const momentum = Math.random() - 0.4;
      if (momentum > 0.2)
        addOrderToBook(
          target,
          "buy",
          Math.round((target.price + Math.random() * 1.5) * 100) / 100,
          Math.floor(Math.random() * 5)
        );
      else if ((npc.holdings[target.symbol] || 0) > 0 && Math.random() < 0.2)
        addOrderToBook(
          target,
          "sell",
          Math.round((target.price - Math.random() * 0.5) * 100) / 100,
          Math.floor(Math.random() * (npc.holdings[target.symbol] || 1))
        );
    }
    matchCompanyOrders(target);
    await target.save();
    await npc.save();
  }
  await broadcastState();
}

// ---------- Broadcast ----------
let lastBroadcast = 0;
async function broadcastState(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcast < 200) return;
  lastBroadcast = now;
  const companies = await Company.find().lean();
  const market = await Market.findOne().lean();
  const compact = companies.map((c) => ({
    name: c.name,
    symbol: c.symbol,
    price: c.price,
    volume: c.volume,
    orderBook: {
      buy: (c.orderBook?.buy || []).slice(0, 8),
      sell: (c.orderBook?.sell || []).slice(0, 8),
    },
  }));
  io.emit("state", { companies: compact, market });
}

// ---------- Socket.io ----------
io.on("connection", async (socket) => {
  const ip =
    socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  let user = await User.findOne({ ip });
  if (!user) user = await User.create({ ip });
  socket.user = user;
  socket.emit("userData", {
    balance: user.balance,
    holdings: user.holdings,
    learningMode: user.learningMode,
  });

  socket.on("placeOrder", async (data) => {
    const {
      symbol,
      side,
      price,
      amount,
      type = "limit",
      stopPrice = null,
    } = data;
    const company = await Company.findOne({ symbol });
    if (!company) return socket.emit("err", "company not found");
    addOrderToBook(
      company,
      side,
      price,
      amount,
      socket.user._id,
      type,
      stopPrice
    );
    const trades = matchCompanyOrders(company); // 約定情報を返すようにする

    await Company.findOneAndUpdate(
      { _id: company._id },
      {
        $set: {
          orderBook: company.orderBook,
          price: company.price,
          volume: company.volume,
        },
      }
    );

    let userUpdated = false;

    for (let t of trades) {
      if (t.buyUserId && t.buyUserId.equals(socket.user._id)) {
        socket.user.balance -= t.price * t.amount;
        socket.user.holdings[symbol] =
          (socket.user.holdings[symbol] || 0) + t.amount;
        userUpdated = true;
      }
      if (t.sellUserId && t.sellUserId.equals(socket.user._id)) {
        if ((socket.user.holdings[symbol] || 0) < t.amount) {
          t.amount = socket.user.holdings[symbol] || 0; // 空売り防止
        }
        socket.user.holdings[symbol] -= t.amount;
        socket.user.balance += t.price * t.amount;
        userUpdated = true;
      }
    }

    if (userUpdated) await socket.user.save(); // ここだけ

    await broadcastState();
  });
});

// ---------- Loops ----------
async function startLoops() {
  setInterval(runNpcActions, 3000);
  setInterval(marketTick, 5000);
}

// ---------- Start ----------
async function start() {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error("Please set MONGO_URI env var");
    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB connected!");
    await initDB();
    await startLoops();
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error(err);
  }
}
start();
