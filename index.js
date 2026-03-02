require("dotenv").config();

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");

const connectDB = require("./config/db");
const User = require("./models/User");
const Bill = require("./models/Bill");

connectDB();

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/* =====================================================
   UTILITIES
===================================================== */

const isAdmin = (ctx) =>
  ctx.from.id.toString() === process.env.ADMIN_ID;

const safeReply = async (ctx, message, options = {}) => {
  try { return await ctx.reply(message, options); }
  catch (err) { console.error("Reply error:", err.message); }
};

const deleteCommandMessage = async (ctx) => {
  if (ctx.chat.type !== "private") {
    try { await ctx.deleteMessage(); } catch {}
  }
};

const getActiveBill = async () =>
  await Bill.findOne({ isActive: true });

const formatCurrency = (amount) =>
  `₦${Number(amount).toFixed(2)}`;

const calculateDaysLeft = (dueDate) =>
  Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24));

/* =====================================================
   START
===================================================== */

bot.start(async (ctx) => {
  const telegramId = ctx.from.id.toString();

  let user = await User.findOne({ telegramId });

  if (!user) {
    user = await User.create({
      telegramId,
      username: ctx.from.username || "",
      fullName: `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim(),
      role: telegramId === process.env.ADMIN_ID ? "ADMIN" : "TENANT",
      isActive: true
    });
  }

  safeReply(ctx, `👋 Welcome ${user.fullName}`);
});

/* =====================================================
   NEW BILL (PROPER ENGINEERING VERSION)
===================================================== */

bot.command("newbill", async (ctx) => {
  try {
    deleteCommandMessage(ctx);
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2)
      return safeReply(ctx, "Usage:\n/newbill 2000\n/newbill 2000 @user1 @user2");

    const amount = parseFloat(parts[1]);
    if (!amount || amount <= 0)
      return safeReply(ctx, "Amount must be greater than 0.");

    const taggedUsernames = parts
      .slice(2)
      .filter(p => p.startsWith("@"))
      .map(u => u.replace("@", "").toLowerCase());

    let tenants;

    if (taggedUsernames.length === 0) {
      tenants = await User.find({ isActive: true });
    } else {
      tenants = await User.find({
        username: { $in: taggedUsernames },
        isActive: true
      });

      if (tenants.length !== taggedUsernames.length)
        return safeReply(ctx, "Some tagged users are invalid or missing username.");
    }

    if (!tenants.length)
      return safeReply(ctx, "No users to bill.");

    const splitAmount = amount / tenants.length;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    await Bill.updateMany({ isActive: true }, { isActive: false });

    const bill = await Bill.create({
      totalAmount: amount,
      splitAmount,
      totalPeople: tenants.length,
      dueDate,
      payments: [],
      billedTenants: tenants.map(t => t.telegramId),
      isActive: true,
      lateFeeApplied: false,
      createdAt: new Date()
    });

    const mentions = tenants.map(t =>
      t.username
        ? `@${t.username}`
        : `<a href="tg://user?id=${t.telegramId}">${t.fullName}</a>`
    ).join(" ");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⚡ <b>New Bill Created</b>\n\n` +
      `💰 Total: ${formatCurrency(amount)}\n` +
      `👥 Sharing: ${tenants.length}\n` +
      `💵 Each: ${formatCurrency(splitAmount)}\n` +
      `📅 Due: ${dueDate.toDateString()}\n\n${mentions}`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("NewBill error:", err);
  }
});

/* =====================================================
   PAY (CRASH PROOF)
===================================================== */

bot.command("pay", async (ctx) => {
  try {
    deleteCommandMessage(ctx);

    const telegramId = ctx.from.id.toString();
    const user = await User.findOne({ telegramId });
    if (!user) return safeReply(ctx, "❌ Not registered.");
    if (!user.isActive) return safeReply(ctx, "🚫 Inactive.");

    const bill = await getActiveBill();
    if (!bill) return safeReply(ctx, "❌ No active bill.");

    // CRASH PROTECTION
    const billedTenants = bill.billedTenants || [];

    if (!billedTenants.includes(telegramId))
      return safeReply(ctx, "You are not included in this bill.");

    if (bill.payments.some(p => p.telegramId === telegramId))
      return safeReply(ctx, "✅ Already paid.");

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: `${telegramId}@compound.com`,
        amount: Math.round(bill.splitAmount * 100),
        currency: "NGN",
        metadata: { telegramId }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const link = response.data?.data?.authorization_url;
    if (!link) return safeReply(ctx, "❌ Payment initialization failed.");

    await ctx.telegram.sendMessage(
      telegramId,
      `💳 Electricity Bill\nAmount: ${formatCurrency(bill.splitAmount)}`,
      Markup.inlineKeyboard([
        Markup.button.url("💰 Pay Now", link)
      ])
    );

    safeReply(ctx, "🔒 Payment link sent privately.");

  } catch (err) {
    console.error("PAY ERROR:", err.response?.data || err.message);
    safeReply(ctx, "❌ Payment initialization failed.");
  }
});

/* =====================================================
   WEBHOOK (SAFE)
===================================================== */

app.post("/paystack-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];

    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body)
      .digest("hex");

    if (hash !== signature) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString());
    if (event.event !== "charge.success")
      return res.sendStatus(200);

    const telegramId = event.data.metadata.telegramId.toString();
    const reference = event.data.reference;
    const amount = event.data.amount / 100;

    const bill = await getActiveBill();
    if (!bill) return res.sendStatus(200);

    const billedTenants = bill.billedTenants || [];

    if (!billedTenants.includes(telegramId))
      return res.sendStatus(200);

    if (bill.payments.some(p => p.reference === reference))
      return res.sendStatus(200);

    const user = await User.findOne({ telegramId });

    bill.payments.push({
      telegramId,
      fullName: user?.fullName || "Tenant",
      amount,
      reference,
      paidAt: new Date()
    });

    await bill.save();

    await bot.telegram.sendMessage(
      telegramId,
      `🧾 Receipt\nAmount: ${formatCurrency(amount)}\nRef: ${reference}`
    );

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `🎉 ${user?.username ? '@' + user.username : user.fullName} paid\n` +
      `Progress: ${bill.payments.length}/${bill.totalPeople}`
    );

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/* =====================================================
   SERVER
===================================================== */

app.get("/", (req, res) =>
  res.send("🚀 Compound Billing Engine Running")
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`Server running on ${PORT}`)
);

bot.launch().then(() =>
  console.log("Bot running...")
);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));