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
async function matchCompanyOrders(company) {
  const buy = company.orderBook.buy;
  const sell = company.orderBook.sell;
  let lastPrice = company.price;
  const trades = [];

  while (buy.length && sell.length && buy[0].price >= sell[0].price) {
    const buyer = buy[0];
    const seller = sell[0];

    const buyerDoc = buyer.userId ? await User.findById(buyer.userId) : null;
    const sellerDoc = seller.userId ? await User.findById(seller.userId) : null;

    let dealAmount = Math.min(buyer.amount, seller.amount);

    // 買いユーザー残高チェック
    if (buyerDoc) {
      const affordable = Math.floor(buyerDoc.balance / buyer.price);
      dealAmount = Math.min(dealAmount, affordable);
    }

    // 売りユーザー株チェック
    if (sellerDoc) {
      const available = sellerDoc.holdings[company.symbol] || 0;
      dealAmount = Math.min(dealAmount, available);
    }

    if (dealAmount <= 0) {
      // 取引できない場合は注文削除
      if (buyerDoc && dealAmount === 0) buy.shift();
      if (sellerDoc && dealAmount === 0) sell.shift();
      continue;
    }

    const dealPrice =
      buyer.type === "market"
        ? company.price
        : seller.type === "market"
        ? company.price
        : (buyer.price + seller.price) / 2;

    lastPrice = dealPrice;
    company.volume = (company.volume || 0) + dealAmount;

    const trade = {
      symbol: company.symbol,
      price: dealPrice,
      amount: dealAmount,
      buyUserId: buyer.userId,
      sellUserId: seller.userId,
      timestamp: new Date(),
    };
    trades.push(trade);
    io.emit("trade", trade);

    // ユーザー更新
    if (buyerDoc) {
      buyerDoc.balance -= dealAmount * dealPrice;
      buyerDoc.holdings[company.symbol] =
        (buyerDoc.holdings[company.symbol] || 0) + dealAmount;
      await buyerDoc.save();
    }
    if (sellerDoc) {
      sellerDoc.holdings[company.symbol] -= dealAmount;
      sellerDoc.balance += dealAmount * dealPrice;
      await sellerDoc.save();
    }

    // 注文残量を減らす
    buyer.amount -= dealAmount;
    seller.amount -= dealAmount;
    if (buyer.amount <= 0) buy.shift();
    if (seller.amount <= 0) sell.shift();
  }

  company.price = clamp(lastPrice, 1, Number.MAX_SAFE_INTEGER);
  return trades;
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

    // NPC 注文追加（買い・売りともに安全）
    if (npc.type === "short") {
      if (Math.random() < 0.6) {
        addOrderToBook(
          target,
          "buy",
          Math.max(
            1,
            Math.round((target.price - Math.random() * 2) * 100) / 100
          ),
          Math.floor(Math.random() * 5) + 1
        );
      } else {
        const qty = Math.max(1, Math.floor(Math.random() * 3));
        if ((npc.holdings[target.symbol] || 0) >= qty)
          addOrderToBook(
            target,
            "sell",
            Math.round((target.price + Math.random() * 2) * 100) / 100,
            qty
          );
      }
    }
    // long, trend も同様に addOrderToBook

    // ここを await して約定を反映
    await matchCompanyOrders(target);

    await Company.updateOne(
      { _id: target._id },
      {
        $set: {
          orderBook: target.orderBook,
          price: target.price,
          volume: target.volume,
        },
      }
    );
    await NPC.updateOne({ _id: npc._id }, { $set: { holdings: npc.holdings } });
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
    const { symbol, side, price, amount, type = "limit" } = data;
    const company = await Company.findOne({ symbol });
    if (!company) return socket.emit("err", "会社が見つかりません");

    // 成行の場合は現在株価を使用
    const finalPrice = type === "market" ? company.price : price;

    // 注文を追加
    addOrderToBook(company, side, finalPrice, amount, socket.user._id, type);

    // 約定処理を await
    await matchCompanyOrders(company);

    // 最新のユーザー情報を DB から取得して socket.user に反映
    const freshUser = await User.findById(socket.user._id);
    socket.user = freshUser;

    // クライアントに送信
    socket.emit("userData", {
      balance: freshUser.balance,
      holdings: freshUser.holdings,
      learningMode: freshUser.learningMode,
    });

    // 会社情報も更新
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

    // 全体状態もブロードキャスト
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
