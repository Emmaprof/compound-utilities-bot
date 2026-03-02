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

@@ -39,11 +36,17 @@
  }
};

const deleteCommandMessage = async (ctx) => {
  if (ctx.chat.type !== "private") {
    try { await ctx.deleteMessage(); } catch {}
  }
};

const getActiveBill = async () =>
  await Bill.findOne({ isActive: true });

const calculateDaysLeft = (dueDate) =>
  Math.ceil((dueDate - new Date()) / (1000 * 60 * 60 * 24));
  Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24));

const formatCurrency = (amount) =>
  `₦${Number(amount).toFixed(2)}`;
@@ -69,7 +72,8 @@
      return safeReply(ctx, `✅ Registered as ${user.role}`);
    }

    return safeReply(ctx, `👋 Welcome back ${user.fullName}\nRole: ${user.role}`);
    safeReply(ctx, `👋 Welcome back ${user.fullName}\nRole: ${user.role}`);

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Registration error.");
@@ -81,7 +85,10 @@
===================================================== */
bot.command("newbill", async (ctx) => {
  try {
    if (!isAdmin(ctx)) return safeReply(ctx, "❌ Admin only.");
    deleteCommandMessage(ctx);

    if (!isAdmin(ctx))
      return safeReply(ctx, "❌ Admin only.");

    const amount = parseFloat(ctx.message.text.split(" ")[1]);
    if (!amount || amount <= 0)
@@ -106,96 +113,133 @@
      payments: [],
      isActive: true,
      lateFeeApplied: false,
      createdAt: new Date()
    });

    safeReply(
      ctx,
      `⚡ *New Bill Created*\n\n` +
      `⚡ <b>New Bill Created</b>\n\n` +
      `💰 Total: ${formatCurrency(amount)}\n` +
      `👥 Tenants: ${activeUsers.length}\n` +
      `💵 Each: ${formatCurrency(splitAmount)}\n` +
      `📅 Due: ${dueDate.toDateString()}`,
      { parse_mode: "Markdown" }
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error creating bill.");
  }
});

/* =====================================================
   PAYMENT INIT
   MARK PAID (ADMIN MANUAL ENTRY)
   Usage: /markpaid telegramId amount reference
===================================================== */
async function initializePayment(email, amount, telegramId) {
bot.command("markpaid", async (ctx) => {
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
    deleteCommandMessage(ctx);

    if (!isAdmin(ctx))
      return safeReply(ctx, "❌ Admin only.");

    const parts = ctx.message.text.split(" ");
    if (parts.length < 4)
      return safeReply(ctx, "❌ Usage: /markpaid telegramId amount reference");

    const telegramId = parts[1];
    const amount = parseFloat(parts[2]);
    const reference = parts[3];

    const bill = await getActiveBill();
    if (!bill)
      return safeReply(ctx, "❌ No active bill.");

    if (bill.payments.some(p => p.telegramId === telegramId))
      return safeReply(ctx, "⚠ User already paid.");

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
      process.env.GROUP_ID,
      `🎉 Payment recorded for <a href="tg://user?id=${telegramId}">${user?.fullName || "Tenant"}</a>\n` +
      `Progress: ${bill.payments.length}/${bill.totalPeople}`,
      { parse_mode: "HTML" }
    );

    return response.data.data.authorization_url;
  } catch (error) {
    console.error("Paystack Init Error:", error.response?.data || error.message);
    return null;
    safeReply(ctx, "✅ Manual payment recorded.");

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error recording payment.");
  }
}
});

/* =====================================================
   PAY
===================================================== */
bot.command("pay", async (ctx) => {
  try {
    deleteCommandMessage(ctx);

    const telegramId = ctx.from.id.toString();
    const user = await User.findOne({ telegramId });

    if (!user) return safeReply(ctx, "❌ Not registered.");
    if (!user.isActive) return safeReply(ctx, "🚫 Inactive this cycle.");
    if (!user.isActive) return safeReply(ctx, "🚫 Inactive.");

    const bill = await getActiveBill();
    if (!bill) return safeReply(ctx, "❌ No active bill.");

    if (bill.payments.some(p => p.telegramId === telegramId))
      return safeReply(ctx, "✅ Already paid.");

    const link = await initializePayment(
      `${telegramId}@compound.com`,
      bill.splitAmount,
      telegramId
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: `${telegramId}@compound.com`,
        amount: Math.round(bill.splitAmount * 100),
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

    if (!link)
      return safeReply(ctx, "❌ Payment initialization failed.");
    const link = response.data.data.authorization_url;

    await ctx.telegram.sendMessage(
      telegramId,
      `💳 Electricity Bill\n\n` +
      `Amount: ${formatCurrency(bill.splitAmount)}\n\n` +
      `Click below to pay securely:`,
      `💳 Electricity Bill\n\nAmount: ${formatCurrency(bill.splitAmount)}`,
      Markup.inlineKeyboard([
        Markup.button.url("💰 Pay Now", link),
        Markup.button.url("💰 Pay Now", link)
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
   HISTORY
===================================================== */
bot.command("history", async (ctx) => {
  try {
@@ -205,33 +249,69 @@
    const telegramId = ctx.from.id.toString();

    const bills = await Bill.find({
      payments: { $elemMatch: { telegramId } }
      "payments.telegramId": telegramId
    }).sort({ createdAt: -1 });

    if (!bills.length)
      return safeReply(ctx, "📭 No payment history.");
      return safeReply(ctx, "📭 No history found.");

    let total = 0;
    let msg = `📜 *Payment History*\n\n`;
    let msg = `<b>Your Payment History</b>\n\n`;

    for (const bill of bills) {
      const p = bill.payments.find(x => x.telegramId === telegramId);
      if (!p) continue;
      const payment = bill.payments.find(
        p => p.telegramId === telegramId
      );

      total += p.amount;
      total += payment.amount;

      msg +=
        `🗓 ${bill.dueDate.toDateString()}\n` +
        `💰 ${formatCurrency(p.amount)}\n` +
        `🔗 ${p.reference}\n\n`;
        `💰 ${formatCurrency(payment.amount)}\n` +
        `🆔 ${payment.reference}\n\n`;
    }

    msg += `💵 *Total Paid:* ${formatCurrency(total)}`;
    msg += `<b>Total Paid:</b> ${formatCurrency(total)}`;

    safeReply(ctx, msg, { parse_mode: "HTML" });

    safeReply(ctx, msg, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error fetching history.");
    safeReply(ctx, "❌ History error.");
  }
});

/* =====================================================
   MY BALANCE
===================================================== */
bot.command("mybalance", async (ctx) => {
  try {
    if (ctx.chat.type !== "private")
      return safeReply(ctx, "⚠ Use in private chat.");

    const telegramId = ctx.from.id.toString();
    const bill = await getActiveBill();

    if (!bill)
      return safeReply(ctx, "✅ No active bill.");

    const payment = bill.payments.find(
      p => p.telegramId === telegramId
    );

    if (payment)
      return safeReply(ctx, `✅ Paid: ${formatCurrency(payment.amount)}`);

    safeReply(
      ctx,
      `⚠ Outstanding Balance\n\n` +
      `Amount: ${formatCurrency(bill.splitAmount)}\n` +
      `Due: ${bill.dueDate.toDateString()}`
    );

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Balance error.");
  }
});

@@ -250,49 +330,53 @@
    if (hash !== signature) return res.sendStatus(401);

    const event = JSON.parse(req.body.toString());
    if (event.event !== "charge.success") return res.sendStatus(200);
    if (event.event !== "charge.success")
      return res.sendStatus(200);

    const telegramId = event.data.metadata.telegramId.toString();
    const reference = event.data.reference;
    const paidAmount = event.data.amount / 100;
    const amount = event.data.amount / 100;

    const bill = await getActiveBill();
    if (!bill) return res.sendStatus(200);

    if (bill.payments.some(p => p.reference === reference)) return res.sendStatus(200);
    if (bill.payments.some(p => p.telegramId === telegramId)) return res.sendStatus(200);
    if (bill.payments.some(p => p.reference === reference))
      return res.sendStatus(200);

    const user = await User.findOne({ telegramId });

    bill.payments.push({
      telegramId,
      fullName: user?.fullName || "Tenant",
      amount: paidAmount,
      amount,
      reference,
      paidAt: new Date(),
      paidAt: new Date()
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
      `🧾 Receipt\n\nAmount: ${formatCurrency(amount)}\nRef: ${reference}`
    );

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `🎉 Payment received from <a href="tg://user?id=${telegramId}">${user?.fullName || "Tenant"}</a>\n` +
      `Progress: ${bill.payments.length}/${bill.totalPeople}`,
      { parse_mode: "HTML" }
    );

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/* =====================================================
   SMART REMINDER
   REMINDER
===================================================== */
cron.schedule("0 9 * * *", async () => {
  try {
@@ -311,38 +395,39 @@
    const daysLeft = calculateDaysLeft(bill.dueDate);

    const mentions = unpaid
      .map(u => `[${u.fullName}](tg://user?id=${u.telegramId})`)
      .map(u =>
        `<a href="tg://user?id=${u.telegramId}">${u.fullName}</a>`
      )
      .join("\n");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⏰ *Reminder*\n\n` +
      `⏰ <b>Reminder</b>\n\n` +
      `💰 ${formatCurrency(bill.splitAmount)}\n` +
      `📅 ${daysLeft} day(s) left\n\n` +
      `Pending:\n${mentions}`,
      { parse_mode: "Markdown" }
      `📅 ${daysLeft} day(s) left\n\n${mentions}`,
      { parse_mode: "HTML" }
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