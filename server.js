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

// 注文板のエントリーのためのスキーマを定義
const OrderEntrySchema = new mongoose.Schema({
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true }, // 注文を出したユーザーまたはNPCのID
  isNPC: { type: Boolean, required: true }, // NPCからの注文なら true、ユーザーからの注文なら false
  price: { type: Number, required: true },
  amount: { type: Number, required: true },
  type: { type: String, enum: ["limit", "market", "stop"], required: true }, // "limit" (指値), "market" (成行), "stop" (逆指値)
  stopPrice: { type: Number, default: null }, // 逆指値注文のトリガー価格
});

const CompanySchema = new mongoose.Schema({
  name: { type: String, unique: true },
  symbol: String,
  price: Number,
  volume: Number,
  sharesOutstanding: Number,
  fundamentals: { revenue: Number, profit: Number, rnd: Number },
  volatility: { type: Number, default: 0.02 },
  orderBook: {
    buy: [OrderEntrySchema], // 買い注文のリスト
    sell: [OrderEntrySchema], // 売り注文のリスト
  },
  lastUpdated: Date,
});

const NPCSchema = new mongoose.Schema({
  name: String,
  type: String, // 例: "short", "long", "trend" (NPCの取引戦略)
  funds: Number, // 初期資金
  holdings: { type: Object, default: {} }, // 保有株 (シンボル: 数量)
  balance: { type: Number, default: 0 }, // NPCの現在の残高
});

const MarketSchema = new mongoose.Schema({
  interestRate: Number,
  lastPolicyEvent: Date,
});

const UserSchema = new mongoose.Schema({
  ip: { type: String, unique: true }, // ユーザーを識別するためのIPアドレス（簡易的な識別子）
  balance: { type: Number, default: 100000 }, // ユーザーの残高
  holdings: { type: Object, default: {} }, // ユーザーの保有株 (シンボル: 数量)
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
  // 買い注文は価格が高い順、売り注文は価格が安い順にソート
  book.buy.sort((a, b) => b.price - a.price);
  book.sell.sort((a, b) => a.price - b.price);
}

// ユーザーまたはNPCのドキュメントを取得するヘルパー関数
async function getActorDocument(actorId, isNPC) {
  if (!actorId) return null;
  if (isNPC) {
    return await NPC.findById(actorId);
  } else {
    return await User.findById(actorId);
  }
}

// 注文を注文板に追加する、または成行注文を即時実行する関数
async function addOrderToBook(
  actorId,
  isNPC,
  company,
  side,
  type,
  price,
  amount,
  stopPrice = null
) {
  // 注文エントリーを作成
  const orderBookEntry = {
    actorId: new mongoose.Types.ObjectId(actorId), // actorIdをObjectId型に変換
    isNPC,
    price,
    amount,
    type,
    stopPrice,
  };

  if (type === "market") {
    // 成行注文は即座に約定を試みるため、注文板には追加しない
    if (side === "buy") {
      await executeMarketBuy(actorId, isNPC, company, amount);
    } else if (side === "sell") {
      await executeMarketSell(actorId, isNPC, company, amount);
    }
    // 成行注文の場合、注文板のソートは不要
  } else if (type === "limit" || type === "stop") {
    // 指値注文と逆指値注文は注文板に追加
    if (side === "buy") {
      company.orderBook.buy.push(orderBookEntry);
    } else {
      company.orderBook.sell.push(orderBookEntry);
    }
    sortOrderBook(company.orderBook); // 追加後に注文板をソート
  }
  // companyオブジェクトは参照渡しされているため、呼び出し元で保存する必要がある
}

// 注文板のマッチングを行い、取引を成立させる関数
async function matchCompanyOrders(company) {
  const buy = company.orderBook.buy;
  const sell = company.orderBook.sell;
  let lastPrice = company.price;
  const trades = [];

  // ストップ注文のトリガーチェック (簡略化されたロジック)
  const currentPrice = company.price;
  let orderBookChanged = false;

  // 買いストップ注文のトリガー (価格がstopPriceを上回ったら買い)
  // 後ろからループして削除に対応
  for (let i = buy.length - 1; i >= 0; i--) {
    if (
      buy[i].type === "stop" &&
      buy[i].stopPrice !== null &&
      currentPrice >= buy[i].stopPrice
    ) {
      console.log(
        `Triggering stop buy for ${company.symbol} (actor: ${buy[i].actorId}) at ${currentPrice}`
      );
      // ストップ注文を板から削除し、成行買いに変換して再処理
      const triggeredOrder = buy.splice(i, 1)[0];
      await addOrderToBook(
        triggeredOrder.actorId,
        triggeredOrder.isNPC,
        company,
        "buy",
        "market",
        currentPrice,
        triggeredOrder.amount
      );
      orderBookChanged = true;
    }
  }

  // 売りストップ注文のトリガー (価格がstopPriceを下回ったら売り)
  // 後ろからループして削除に対応
  for (let i = sell.length - 1; i >= 0; i--) {
    if (
      sell[i].type === "stop" &&
      sell[i].stopPrice !== null &&
      currentPrice <= sell[i].stopPrice
    ) {
      console.log(
        `Triggering stop sell for ${company.symbol} (actor: ${sell[i].actorId}) at ${currentPrice}`
      );
      // ストップ注文を板から削除し、成行売りに変換して再処理
      const triggeredOrder = sell.splice(i, 1)[0];
      await addOrderToBook(
        triggeredOrder.actorId,
        triggeredOrder.isNPC,
        company,
        "sell",
        "market",
        currentPrice,
        triggeredOrder.amount
      );
      orderBookChanged = true;
    }
  }

  if (orderBookChanged) {
    sortOrderBook(company.orderBook); // 新しく追加された成行注文をソート
  }

  // 買い注文と売り注文をマッチング
  while (buy.length && sell.length && buy[0].price >= sell[0].price) {
    const buyerOrder = buy[0];
    const sellerOrder = sell[0];

    // 買い手と売り手のドキュメントを取得
    const buyerDoc = await getActorDocument(
      buyerOrder.actorId,
      buyerOrder.isNPC
    );
    const sellerDoc = await getActorDocument(
      sellerOrder.actorId,
      sellerOrder.isNPC
    );

    let dealAmount = Math.min(buyerOrder.amount, sellerOrder.amount);

    // 買い手側の資金チェック (指値注文のみ)
    if (buyerDoc && buyerOrder.type !== "market") {
      const affordable = Math.floor(buyerDoc.balance / buyerOrder.price);
      dealAmount = Math.min(dealAmount, affordable);
    }

    // 売り手側の保有株チェック (指値注文のみ)
    if (sellerDoc && sellerOrder.type !== "market") {
      const available = sellerDoc.holdings[company.symbol] || 0;
      dealAmount = Math.min(dealAmount, available);
    }

    // 約定量が0の場合、これ以上約定できないため両方の注文を板から削除
    if (dealAmount <= 0) {
      buy.shift();
      sell.shift();
      continue;
    }

    let dealPrice;
    // 約定価格の決定ロジック
    if (buyerOrder.type === "market") {
      dealPrice = sellerOrder.price; // 買い成行は売り板の最安値で約定
    } else if (sellerOrder.type === "market") {
      dealPrice = buyerOrder.price; // 売り成行は買い板の最高値で約定
    } else {
      // 両方指値の場合、中間値で約定
      dealPrice = (buyerOrder.price + sellerOrder.price) / 2;
    }

    lastPrice = dealPrice;
    company.volume = (company.volume || 0) + dealAmount; // 取引量を更新

    // 取引履歴を作成し、クライアントにブロードキャスト
    const trade = {
      symbol: company.symbol,
      price: dealPrice,
      amount: dealAmount,
      buyActorId: buyerOrder.actorId,
      sellActorId: sellerOrder.actorId,
      timestamp: new Date(),
    };
    trades.push(trade);
    io.emit("trade", trade);

    // ユーザー/NPCの残高と保有株を更新し、データベースに保存
    if (buyerDoc) {
      buyerDoc.balance -= dealAmount * dealPrice;
      buyerDoc.holdings[company.symbol] =
        (buyerDoc.holdings[company.symbol] || 0) + dealAmount;
      await buyerDoc.save(); // 買い手のデータを保存
    }
    if (sellerDoc) {
      sellerDoc.holdings[company.symbol] -= dealAmount;
      sellerDoc.balance += dealAmount * dealPrice;
      await sellerDoc.save(); // 売り手のデータを保存
    }

    // 注文残量を減らす
    buyerOrder.amount -= dealAmount;
    sellerOrder.amount -= dealAmount;
    if (buyerOrder.amount <= 0) buy.shift(); // 買い注文が完了したら板から削除
    if (sellerOrder.amount <= 0) sell.shift(); // 売り注文が完了したら板から削除
  }

  // 最新の約定価格で会社の価格を更新
  company.price = clamp(lastPrice, 1, Number.MAX_SAFE_INTEGER);
  return trades;
}

// 注文板の買いと売りの不均衡を計算
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
      {
        name: "Falcon Trader",
        type: "short",
        funds: 50000,
        balance: 50000,
        holdings: { AEEN: 5, CRWK: 2 },
      },
      {
        name: "Quiet Whale",
        type: "long",
        funds: 200000,
        balance: 200000,
        holdings: { AEEN: 10, LGSH: 5 },
      },
      {
        name: "Ripple Mind",
        type: "trend",
        funds: 80000,
        balance: 80000,
        holdings: { TRFD: 8 },
      },
    ]);
  }

  if ((await Market.countDocuments()) === 0) {
    await Market.create({ interestRate: 1.0, lastPolicyEvent: null });
  }
}

// ---------- Market Tick ----------
// 市場価格を定期的に更新する関数
async function marketTick() {
  const market = await Market.findOne();
  const companies = await Company.find();
  for (let company of companies) {
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
    // 価格の急激な変動を抑える
    newPrice = company.price * clamp(newPrice / company.price, 0.9, 1.1);
    if (newPrice < 1) newPrice = 1; // 1未満にならないように
    const updatedFields = {
      price: Number(newPrice.toFixed(4)),
      // volumeはマッチング時に更新されるため、ここではリセットまたは維持
      // 今回はマッチング後の値が保持されるように、marketTickではvolumeを更新しない
      lastUpdated: new Date(),
    };
    await Company.findOneAndUpdate(
      { _id: company._id },
      { $set: updatedFields }
    );
  }
  await broadcastState(); // 市場状態をクライアントにブロードキャスト
}

// ---------- NPC ----------
// NPCが定期的に取引を行う関数
async function runNpcActions() {
  const npcs = await NPC.find();
  const companies = await Company.find();

  for (let npc of npcs) {
    const target = companies[Math.floor(Math.random() * companies.length)]; // ランダムな銘柄を選択
    if (!npc.holdings) npc.holdings = {};

    const side = Math.random() < 0.5 ? "buy" : "sell";
    const type = Math.random() < 0.8 ? "limit" : "market"; // NPCは主に指値、たまに成行
    let price;
    let amount = Math.floor(Math.random() * 5) + 1; // 1-5株

    if (side === "buy") {
      // 買い注文は現在の価格よりやや安めに指値
      price = Math.max(
        1,
        Math.round((target.price - Math.random() * 2) * 100) / 100
      );
    } else {
      // 売り注文は現在の価格よりやや高めに指値
      price = Math.round((target.price + Math.random() * 2) * 100) / 100;
    }

    // 売り注文だが株が足りない場合はスキップ
    if (side === "sell" && (npc.holdings[target.symbol] || 0) < amount) {
      continue;
    }
    // 買い注文だが資金が足りない場合はスキップ (成行買いの場合はexecuteMarketBuy内でチェック)
    if (side === "buy" && npc.balance < price * amount && type === "limit") {
      continue;
    }

    // 注文を注文板に追加または即時実行
    await addOrderToBook(npc._id, true, target, side, type, price, amount);

    // 追加された注文と既存の注文のマッチングを試みる
    await matchCompanyOrders(target);

    // Company ドキュメントを更新 (注文板、価格、取引量)
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
    // NPC の holdings と balance は matchCompanyOrders の中で save() されているので、ここでは不要
  }

  await broadcastState(); // 市場状態をクライアントにブロードキャスト
}

// ---------- Broadcast ----------
let lastBroadcast = 0;
async function broadcastState(force = false) {
  const now = Date.now();
  // 頻繁なブロードキャストを避ける (200ms間隔)
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
      // クライアントには上位8件のみ送信し、無効なストップ注文は除外
      buy: (c.orderBook?.buy || [])
        .filter((o) => o.type !== "stop" || o.stopPrice !== null)
        .slice(0, 8),
      sell: (c.orderBook?.sell || [])
        .filter((o) => o.type !== "stop" || o.stopPrice !== null)
        .slice(0, 8),
    },
  }));
  io.emit("state", { companies: compact, market });
}

// 成行買い注文の実行ロジック
async function executeMarketBuy(actorId, isNPC, company, amount) {
  let remaining = amount;
  const sellOrders = company.orderBook.sell;

  sellOrders.sort((a, b) => a.price - b.price); // 価格が安い順にソート

  for (let i = 0; i < sellOrders.length && remaining > 0; i++) {
    const order = sellOrders[i];
    const dealAmount = Math.min(order.amount, remaining);
    const dealPrice = order.price;
    const totalCost = dealAmount * dealPrice;

    // ---- 買い側の更新 ----
    const buyerDoc = await getActorDocument(actorId, isNPC);
    if (!buyerDoc || buyerDoc.balance < totalCost) {
      console.warn(
        `Market buy for ${company.symbol} (actor: ${actorId}) failed due to insufficient funds.`
      );
      break; // 資金不足でこれ以上買えない
    }
    buyerDoc.balance -= totalCost;
    buyerDoc.holdings[company.symbol] =
      (buyerDoc.holdings[company.symbol] || 0) + dealAmount;
    await buyerDoc.save(); // 買い手のデータを保存

    // ---- 売り側の更新 ----
    const sellerDoc = await getActorDocument(order.actorId, order.isNPC);
    if (sellerDoc) {
      sellerDoc.balance += totalCost;
      sellerDoc.holdings[company.symbol] -= dealAmount;
      await sellerDoc.save(); // 売り手のデータを保存
    }

    // ---- 会社側の更新 ----
    company.price = dealPrice; // 最新の約定価格で更新
    company.volume = (company.volume || 0) + dealAmount; // 取引量を更新

    // 注文残量
    order.amount -= dealAmount;
    if (order.amount <= 0) {
      sellOrders.splice(i, 1);
      i--;
    }

    remaining -= dealAmount;
  }

  return remaining; // 約定しなかった残量
}

// 成行売り注文の実行ロジック
async function executeMarketSell(actorId, isNPC, company, amount) {
  let remaining = amount;
  const buyOrders = company.orderBook.buy;

  buyOrders.sort((a, b) => b.price - a.price); // 価格が高い順にソート

  for (let i = 0; i < buyOrders.length && remaining > 0; i++) {
    const order = buyOrders[i];
    const dealAmount = Math.min(order.amount, remaining);
    const dealPrice = order.price;
    const totalGain = dealAmount * dealPrice;

    // ---- 売り側の更新 ----
    const sellerDoc = await getActorDocument(actorId, isNPC);
    if (!sellerDoc || (sellerDoc.holdings[company.symbol] || 0) < dealAmount) {
      console.warn(
        `Market sell for ${company.symbol} (actor: ${actorId}) failed due to insufficient holdings.`
      );
      break; // 株不足でこれ以上売れない
    }
    sellerDoc.balance += totalGain;
    sellerDoc.holdings[company.symbol] -= dealAmount;
    await sellerDoc.save(); // 売り手のデータを保存

    // ---- 買い側の更新 ----
    const buyerDoc = await getActorDocument(order.actorId, order.isNPC);
    if (buyerDoc) {
      buyerDoc.balance -= totalGain;
      buyerDoc.holdings[company.symbol] =
        (buyerDoc.holdings[company.symbol] || 0) + dealAmount;
      await buyerDoc.save(); // 買い手のデータを保存
    }

    // ---- 会社側の更新 ----
    company.price = dealPrice; // 最新の約定価格で更新
    company.volume = (company.volume || 0) + dealAmount; // 取引量を更新

    order.amount -= dealAmount;
    if (order.amount <= 0) {
      buyOrders.splice(i, 1);
      i--;
    }

    remaining -= dealAmount;
  }

  return remaining; // 約定しなかった残量
}

// ---------- Socket.io ----------
io.on("connection", async (socket) => {
  const ip =
    socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  let user = await User.findOne({ ip });
  if (!user) user = await User.create({ ip });
  socket.user = user; // ソケットにユーザー情報を紐付け

  // 接続したクライアントにユーザーデータを送信
  socket.emit("userData", {
    balance: user.balance,
    holdings: user.holdings,
    learningMode: user.learningMode,
  });

  // 接続時に現在の市場状態をブロードキャスト
  await broadcastState(true);

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
    if (!company) {
      return socket.emit("err", "会社が見つかりません");
    }

    // 注文を板に追加 (成行の場合は即時約定を試みる)
    await addOrderToBook(
      socket.user._id,
      false, // isNPC: false (ユーザーの注文)
      company,
      side,
      type,
      price,
      amount,
      stopPrice
    );

    // 追加された注文と既存の注文のマッチングを試みる
    await matchCompanyOrders(company);

    // Company ドキュメントを更新 (注文板、価格、取引量)
    await Company.updateOne(
      { _id: company._id },
      {
        $set: {
          orderBook: company.orderBook,
          price: company.price,
          volume: company.volume,
        },
      }
    );

    // ユーザーデータを最新の状態に更新してクライアントに送信
    // 注意: freshUser.save() は不要です。
    // 約定処理 (matchCompanyOrders, executeMarketBuy, executeMarketSell) の中で
    // 既に buyerDoc.save() / sellerDoc.save() が呼び出され、DBに保存されています。
    const freshUser = await User.findById(socket.user._id); // DBから最新のユーザー情報を取得
    socket.user = freshUser; // socket.user も更新しておく
    socket.emit("userData", {
      balance: freshUser.balance,
      holdings: freshUser.holdings,
      learningMode: freshUser.learningMode,
    });

    // 市場状態を全クライアントにブロードキャスト
    await broadcastState();
  });
});

// ---------- Loops ----------
async function startLoops() {
  // NPCの行動間隔を調整 (例: 3秒ごと)
  setInterval(runNpcActions, 3000);
  // 市場価格の更新間隔を調整 (例: 5秒ごと)
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
    // It's good practice to clear the database and re-initialize if schema changes
    // If you have existing data that causes issues, consider uncommenting these lines
    // await mongoose.connection.db.dropDatabase(); // 開発時のみ有効化することを推奨
    await initDB();
    await startLoops();
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error(err);
  }
}
start();
