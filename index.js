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

const deleteCommandMessage = async (ctx) => {
  if (ctx.chat.type !== "private") {
    try { await ctx.deleteMessage(); } catch {}
  }
};

const getActiveBill = async () =>
  await Bill.findOne({ isActive: true });

const calculateDaysLeft = (dueDate) =>
  Math.ceil((new Date(dueDate) - new Date()) / (1000 * 60 * 60 * 24));

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

    safeReply(ctx, `👋 Welcome back ${user.fullName}\nRole: ${user.role}`);

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Registration error.");
  }
});
/* =====================================================
   ACTIVATE / DEACTIVATE
===================================================== */

bot.command("deactivate", async (ctx) => {
  try {
    deleteCommandMessage(ctx);
    if (!isAdmin(ctx)) return;

    if (!ctx.message.reply_to_message)
      return safeReply(ctx, "Reply to a user to deactivate.");

    const telegramId =
      ctx.message.reply_to_message.from.id.toString();

    const user = await User.findOne({ telegramId });
    if (!user || user.role === "ADMIN") return;

    user.isActive = false;
    await user.save();

    safeReply(ctx, `🚫 ${user.fullName} deactivated.`);
  } catch (err) { console.error(err); }
});

bot.command("activate", async (ctx) => {
  try {
    deleteCommandMessage(ctx);
    if (!isAdmin(ctx)) return;

    if (!ctx.message.reply_to_message)
      return safeReply(ctx, "Reply to a user to activate.");

    const telegramId =
      ctx.message.reply_to_message.from.id.toString();

    const user = await User.findOne({ telegramId });
    if (!user) return;

    user.isActive = true;
    await user.save();

    safeReply(ctx, `✅ ${user.fullName} activated.`);
  } catch (err) { console.error(err); }
});
/* =====================================================
   NEW BILL (TAGGED USERS VERSION)
   Usage: /newbill 200 @user1 @user2
===================================================== */

bot.command("newbill", async (ctx) => {
  try {
    deleteCommandMessage(ctx);
    if (!isAdmin(ctx)) return;

    const parts = ctx.message.text.split(" ");
    const amount = parseFloat(parts[1]);

    if (!amount || amount <= 0)
      return safeReply(ctx, "Usage: /newbill 200 @user1 @user2");

    const usernames = parts.slice(2);

    if (!usernames.length)
      return safeReply(ctx, "Please tag at least one tenant.");

    const cleanUsernames = usernames.map(u =>
      u.replace("@", "").toLowerCase()
    );

    const tenants = await User.find({
      username: { $in: cleanUsernames },
      isActive: true
    });

    if (!tenants.length)
      return safeReply(ctx, "No valid active tenants found.");

    const splitAmount = amount / tenants.length;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    await Bill.updateMany({ isActive: true }, { isActive: false });

    const newBill = await Bill.create({
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

    const mentions = tenants
      .map(t => `@${t.username}`)
      .join(" ");

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⚡ <b>New Electricity Bill</b>\n\n` +
      `💰 Total: ${formatCurrency(amount)}\n` +
      `👥 Sharing: ${tenants.length}\n` +
      `💵 Each: ${formatCurrency(splitAmount)}\n` +
      `📅 Due: ${dueDate.toDateString()}\n\n` +
      `📢 ${mentions}`,
      { parse_mode: "HTML" }
    );

  } catch (err) {
    console.error("NewBill error:", err);
  }
});


/* =====================================================
   MARK PAID (ADMIN MANUAL ENTRY)
   Usage: /markpaid telegramId amount reference
===================================================== */
bot.command("markpaid", async (ctx) => {
  try {
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

    safeReply(ctx, "✅ Manual payment recorded.");

  } catch (err) {
    console.error(err);
    safeReply(ctx, "❌ Error recording payment.");
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
    if (!user.isActive) return safeReply(ctx, "🚫 Inactive.");

    const bill = await getActiveBill();
    if (!bill) return safeReply(ctx, "❌ No active bill.");

    if (!bill.billedTenants.includes(telegramId))
    return safeReply(ctx, "You are not included in this bill.");

    if (bill.payments.some(p => p.telegramId === telegramId))
      return safeReply(ctx, "✅ Already paid.");

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

    const link = response.data.data.authorization_url;

    await ctx.telegram.sendMessage(
      telegramId,
      `💳 Electricity Bill\n\nAmount: ${formatCurrency(bill.splitAmount)}`,
      Markup.inlineKeyboard([
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
   HISTORY
===================================================== */
bot.command("history", async (ctx) => {
  try {
    if (ctx.chat.type !== "private")
      return safeReply(ctx, "⚠ Use in private chat.");

    const telegramId = ctx.from.id.toString();

    const bills = await Bill.find({
      "payments.telegramId": telegramId
    }).sort({ createdAt: -1 });

    if (!bills.length)
      return safeReply(ctx, "📭 No history found.");

    let total = 0;
    let msg = `<b>Your Payment History</b>\n\n`;

    for (const bill of bills) {
      const payment = bill.payments.find(
        p => p.telegramId === telegramId
      );

      total += payment.amount;

      msg +=
        `🗓 ${bill.dueDate.toDateString()}\n` +
        `💰 ${formatCurrency(payment.amount)}\n` +
        `🆔 ${payment.reference}\n\n`;
    }

    msg += `<b>Total Paid:</b> ${formatCurrency(total)}`;

    safeReply(ctx, msg, { parse_mode: "HTML" });

  } catch (err) {
    console.error(err);
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

