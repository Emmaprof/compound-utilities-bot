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

/* =================================
   INITIALIZE
================================= */
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

/* =================================
   UTILITIES
================================= */

const isAdmin = (ctx) =>
  ctx.from.id.toString() === process.env.ADMIN_ID;

const safeReply = async (ctx, message, options = {}) => {
  try {
    return await ctx.reply(message, options);
  } catch (err) {
    console.error("Reply error:", err.message);
  }
};

const getActiveBill = () => Bill.findOne({ isActive: true });

const calculateDaysLeft = (dueDate) =>
  Math.ceil((dueDate - new Date()) / (1000 * 60 * 60 * 24));

/* =================================
   START
================================= */
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

    return safeReply(
      ctx,
      `👋 Welcome back ${user.fullName}\nRole: ${user.role}`
    );
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Registration error.");
  }
});

/* =================================
   NEW BILL
================================= */
bot.command("newbill", async (ctx) => {
  try {
    if (!isAdmin(ctx))
      return safeReply(ctx, "❌ Admin only.");

    const amount = parseFloat(ctx.message.text.split(" ")[1]);

    if (!amount || amount <= 0)
      return safeReply(ctx, "❌ Usage: /newbill 120000");

    const activeUsers = await User.find({ isActive: true });

    if (activeUsers.length === 0)
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
        `💰 ₦${amount}\n` +
        `👥 ${activeUsers.length} tenants\n` +
        `💵 ₦${splitAmount.toFixed(2)} each\n` +
        `📅 Due ${dueDate.toDateString()}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error creating bill.");
  }
});

/* =================================
   INITIALIZE PAYSTACK (LIVE READY)
================================= */
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
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.data.authorization_url;
  } catch (error) {
    console.error("Payment init error:", error.response?.data || error.message);
    return null;
  }
}

/* =================================
   PAY COMMAND
================================= */
bot.command("pay", async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();
    const user = await User.findOne({ telegramId });

    if (!user)
      return safeReply(ctx, "❌ Not registered.");

    if (!user.isActive)
      return safeReply(ctx, "🚫 You are inactive this cycle.");

    const bill = await getActiveBill();
    if (!bill)
      return safeReply(ctx, "❌ No active bill.");

    if (bill.payments.find((p) => p.telegramId === telegramId))
      return safeReply(ctx, "✅ Already paid.");

    const link = await initializePayment(
      `${telegramId}@compound.com`,
      bill.splitAmount,
      telegramId
    );

    if (!link)
      return safeReply(ctx, "❌ Payment failed.");

    await ctx.telegram.sendMessage(
      telegramId,
      `💳 Electricity Bill\n\nAmount: ₦${bill.splitAmount.toFixed(
        2
      )}\n\n Click below to pay securely::`,
      Markup.inlineKeyboard([Markup.button.url("💰 Pay Now", link)])
    );

    safeReply(ctx, "🔒 Payment link sent privately.");
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Payment error.");
  }
});

/* =================================
   PAYSTACK WEBHOOK
================================= */
app.post(
  "/paystack-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const hash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (hash !== req.headers["x-paystack-signature"])
        return res.sendStatus(401);

      const event = JSON.parse(req.body.toString());

      if (event.event === "charge.success") {
        const telegramId = event.data.metadata.telegramId.toString();
        const bill = await getActiveBill();
        if (!bill) return res.sendStatus(200);

        if (bill.payments.find((p) => p.telegramId === telegramId))
          return res.sendStatus(200);

        const user = await User.findOne({ telegramId });

        const paidAmount = event.data.amount / 100;

        bill.payments.push({
          telegramId,
          fullName: user?.fullName || "Tenant",
          amount: paidAmount,
          reference: event.data.reference,
        });

        await bill.save();

        const paidCount = bill.payments.length;

        /* RECEIPT DM */
        try {
          await bot.telegram.sendMessage(
            telegramId,
            `🧾 *Payment Receipt*\n\n` +
              `👤 ${user.fullName}\n` +
              `💰 ₦${paidAmount.toFixed(2)}\n` +
              `🆔 Ref: ${event.data.reference}\n` +
              `📅 ${new Date().toDateString()}\n\n` +
              `✅ Confirmed`,
            { parse_mode: "Markdown" }
          );
        } catch {}

        /* GROUP UPDATE */
        await bot.telegram.sendMessage(
          process.env.GROUP_ID,
          `🎉 Payment received from ${user.fullName}\nProgress: ${paidCount}/${bill.totalPeople}`
        );

        if (paidCount === bill.totalPeople) {
          bill.isActive = false;
          await bill.save();

          await bot.telegram.sendMessage(
            process.env.GROUP_ID,
            `✅ Bill CLOSED. All payments received.`
          );
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("Webhook error:", err);
      res.sendStatus(500);
    }
  }
);

/* =================================
   SMART REMINDER SYSTEM
================================= */
cron.schedule("0 9 * * *", async () => {
  try {
    const bill = await getActiveBill();
    if (!bill) return;

    const activeUsers = await User.find({ isActive: true });
    const paidIds = bill.payments.map((p) => p.telegramId);
    const unpaid = activeUsers.filter(
      (u) => !paidIds.includes(u.telegramId)
    );

    if (unpaid.length === 0) return;

    const daysLeft = calculateDaysLeft(bill.dueDate);

    let urgency = "⏰ Reminder";
    if (daysLeft === 2) urgency = "🔁 2 Days Left";
    if (daysLeft === 1) urgency = "🚨 FINAL WARNING";

    const mentions = unpaid
      .map((u) => `[${u.fullName}](tg://user?id=${u.telegramId})`)
      .join("\n");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `${urgency}\n\n💰 ₦${bill.splitAmount.toFixed(
        2
      )}\n📅 ${daysLeft} day(s) left\n\n⚠ Pending:\n${mentions}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Reminder error:", err);
  }
});

/* =================================
   AUTO LATE FEE (10%)
================================= */
cron.schedule("0 0 * * *", async () => {
  try {
    const bill = await getActiveBill();
    if (!bill) return;

    if (new Date() > bill.dueDate && !bill.lateFeeApplied) {
      bill.splitAmount *= 1.1;
      bill.lateFeeApplied = true;
      await bill.save();

      await bot.telegram.sendMessage(
        process.env.GROUP_ID,
        `💸 10% Late fee applied.\nNew amount: ₦${bill.splitAmount.toFixed(
          2
        )}`
      );
    }
  } catch (err) {
    console.error("Late fee error:", err);
  }
});

/* =================================
   WEEKLY ADMIN REPORT
================================= */
cron.schedule("0 20 * * 0", async () => {
  try {
    const bill = await getActiveBill();
    if (!bill) return;

    const revenue = bill.payments.reduce((s, p) => s + p.amount, 0);

    await bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `📊 Weekly Report\n\nProgress: ${bill.payments.length}/${bill.totalPeople}\nRevenue: ₦${revenue}`
    );
  } catch (err) {
    console.error("Admin report error:", err);
  }
});

/* =================================
   SERVER
================================= */
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