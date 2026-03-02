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

/* =====================================================
   INIT
===================================================== */
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

/* =====================================================
   BODY PARSERS
===================================================== */
app.use("/paystack-webhook", express.raw({ type: "application/json" }));
app.use(express.json());

/* =====================================================
   UTILITIES
===================================================== */

const isAdmin = (ctx) =>
  ctx.from.id.toString() === process.env.ADMIN_ID;

const safeReply = async (ctx, message, options = {}) => {
  try {
    return await ctx.reply(message, options);
  } catch (err) {
    console.error("Reply error:", err.message);
  }
};

const getActiveBill = async () =>
  await Bill.findOne({ isActive: true });

const calculateDaysLeft = (dueDate) =>
  Math.ceil((dueDate - new Date()) / (1000 * 60 * 60 * 24));

const formatCurrency = (amount) =>
  `₦${Number(amount).toFixed(2)}`;

/* =====================================================
   START
===================================================== */
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();

    let user = await User.findOne({ telegramId });

    if (!user) {
      user = await User.create({
        telegramId,
        username: ctx.from.username || "",
        fullName: `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim(),
        role: telegramId === process.env.ADMIN_ID ? "ADMIN" : "TENANT",
        isActive: true,
      });

      return safeReply(ctx, `✅ Registered as ${user.role}`);
    }

    return safeReply(ctx, `👋 Welcome back ${user.fullName}\nRole: ${user.role}`);
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Registration error.");
  }
});

/* =====================================================
   NEW BILL
===================================================== */
bot.command("newbill", async (ctx) => {
  try {
    if (!isAdmin(ctx)) return safeReply(ctx, "❌ Admin only.");

    const amount = parseFloat(ctx.message.text.split(" ")[1]);
    if (!amount || amount <= 0)
      return safeReply(ctx, "❌ Usage: /newbill 120000");

    const activeUsers = await User.find({ isActive: true });
    if (!activeUsers.length)
      return safeReply(ctx, "❌ No active tenants.");

    const splitAmount = amount / activeUsers.length;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    await Bill.updateMany({ isActive: true }, { isActive: false });

    await Bill.create({
      totalAmount: amount,
      splitAmount,
      totalPeople: activeUsers.length,
      dueDate,
      payments: [],
      isActive: true,
      lateFeeApplied: false,
    });

    safeReply(
      ctx,
      `⚡ *New Bill Created*\n\n` +
      `💰 Total: ${formatCurrency(amount)}\n` +
      `👥 Tenants: ${activeUsers.length}\n` +
      `💵 Each: ${formatCurrency(splitAmount)}\n` +
      `📅 Due: ${dueDate.toDateString()}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error creating bill.");
  }
});

/* =====================================================
   PAYMENT INIT
===================================================== */
async function initializePayment(email, amount, telegramId) {
  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100),
        currency: "NGN",
        channels: ["card", "bank", "ussd", "bank_transfer"],
        metadata: { telegramId },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    return response.data.data.authorization_url;
  } catch (error) {
    console.error("Paystack Init Error:", error.response?.data || error.message);
    return null;
  }
}

/* =====================================================
   PAY
===================================================== */
bot.command("pay", async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();
    const user = await User.findOne({ telegramId });

    if (!user) return safeReply(ctx, "❌ Not registered.");
    if (!user.isActive) return safeReply(ctx, "🚫 Inactive this cycle.");

    const bill = await getActiveBill();
    if (!bill) return safeReply(ctx, "❌ No active bill.");

    if (bill.payments.some(p => p.telegramId === telegramId))
      return safeReply(ctx, "✅ Already paid.");

    const link = await initializePayment(
      `${telegramId}@compound.com`,
      bill.splitAmount,
      telegramId
    );

    if (!link)
      return safeReply(ctx, "❌ Payment initialization failed.");

    await ctx.telegram.sendMessage(
      telegramId,
      `💳 Electricity Bill\n\n` +
      `Amount: ${formatCurrency(bill.splitAmount)}\n\n` +
      `Click below to pay securely:`,
      Markup.inlineKeyboard([
        Markup.button.url("💰 Pay Now", link),
      ])
    );

    safeReply(ctx, "🔒 Payment link sent privately.");
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Payment error.");
  }
});

/* =====================================================
   PAYMENT HISTORY
===================================================== */
bot.command("history", async (ctx) => {
  try {
    if (ctx.chat.type !== "private")
      return safeReply(ctx, "⚠ Use in private chat.");

    const telegramId = ctx.from.id.toString();

    const bills = await Bill.find({
      payments: { $elemMatch: { telegramId } }
    }).sort({ createdAt: -1 });

    if (!bills.length)
      return safeReply(ctx, "📭 No payment history.");

    let total = 0;
    let msg = `📜 *Payment History*\n\n`;

    for (const bill of bills) {
      const p = bill.payments.find(x => x.telegramId === telegramId);
      if (!p) continue;

      total += p.amount;

      msg +=
        `🗓 ${bill.dueDate.toDateString()}\n` +
        `💰 ${formatCurrency(p.amount)}\n` +
        `🔗 ${p.reference}\n\n`;
    }

    msg += `💵 *Total Paid:* ${formatCurrency(total)}`;

    safeReply(ctx, msg, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error fetching history.");
  }
});

/* =====================================================
   WEBHOOK
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
    if (event.event !== "charge.success") return res.sendStatus(200);

    const telegramId = event.data.metadata.telegramId.toString();
    const reference = event.data.reference;
    const paidAmount = event.data.amount / 100;

    const bill = await getActiveBill();
    if (!bill) return res.sendStatus(200);

    if (bill.payments.some(p => p.reference === reference)) return res.sendStatus(200);
    if (bill.payments.some(p => p.telegramId === telegramId)) return res.sendStatus(200);

    const user = await User.findOne({ telegramId });

    bill.payments.push({
      telegramId,
      fullName: user?.fullName || "Tenant",
      amount: paidAmount,
      reference,
      paidAt: new Date(),
    });

    await bill.save();

    await bot.telegram.sendMessage(
      telegramId,
      `🧾 *Payment Receipt*\n\n` +
      `👤 ${user?.fullName}\n` +
      `💰 ${formatCurrency(paidAmount)}\n` +
      `🆔 ${reference}\n\n` +
      `✅ Confirmed`,
      { parse_mode: "Markdown" }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/* =====================================================
   SMART REMINDER
===================================================== */
cron.schedule("0 9 * * *", async () => {
  try {
    const bill = await getActiveBill();
    if (!bill) return;

    const activeUsers = await User.find({ isActive: true });
    const paidIds = bill.payments.map(p => p.telegramId);

    const unpaid = activeUsers.filter(
      u => !paidIds.includes(u.telegramId)
    );

    if (!unpaid.length) return;

    const daysLeft = calculateDaysLeft(bill.dueDate);

    const mentions = unpaid
      .map(u => `[${u.fullName}](tg://user?id=${u.telegramId})`)
      .join("\n");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⏰ *Reminder*\n\n` +
      `💰 ${formatCurrency(bill.splitAmount)}\n` +
      `📅 ${daysLeft} day(s) left\n\n` +
      `Pending:\n${mentions}`,
      { parse_mode: "Markdown" }
    );

  } catch (err) {
    console.error("Reminder error:", err);
  }
});

/* =====================================================
   SERVER
===================================================== */
app.get("/", (req, res) =>
  res.send("🚀 Compound Utilities Engine Running")
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`🌍 Server running on ${PORT}`)
);

bot.launch().then(() =>
  console.log("🤖 Bot running...")
);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));