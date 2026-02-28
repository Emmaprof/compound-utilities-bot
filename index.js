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

/* ================================
   INITIALIZE
================================ */
const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();

/* ================================
   UTILITIES
================================ */
const isAdmin = (ctx) =>
  ctx.from.id.toString() === process.env.ADMIN_ID;

const safeReply = (ctx, message, options = {}) => {
  try {
    return ctx.reply(message, options);
  } catch (err) {
    console.error("Reply error:", err);
  }
};

/* ================================
   START COMMAND
================================ */
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();

    let user = await User.findOne({ telegramId });

    if (!user) {
      user = await User.create({
        telegramId,
        username: ctx.from.username || "",
        fullName: `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim(),
        role:
          telegramId === process.env.ADMIN_ID
            ? "ADMIN"
            : "TENANT",
        isActive: true,
      });

      return safeReply(
        ctx,
        `✅ Registered successfully as ${user.role}`
      );
    }

    return safeReply(
      ctx,
      `👋 Welcome back, ${user.fullName}\nRole: ${user.role}`
    );
  } catch (error) {
    console.error(error);
    safeReply(ctx, "❌ Registration error.");
  }
});

/* ================================
   NEW BILL (ACTIVE TENANTS ONLY)
================================ */
bot.command("newbill", async (ctx) => {
  try {
    if (!isAdmin(ctx))
      return safeReply(ctx, "❌ Only ADMIN can create bills.");

    const parts = ctx.message.text.split(" ");
    const amount = parseFloat(parts[1]);

    if (!amount || amount <= 0)
      return safeReply(ctx, "❌ Usage: /newbill 120000");

    const activeUsers = await User.find({ isActive: true });
    const totalPeople = activeUsers.length;

    if (totalPeople === 0)
      return safeReply(ctx, "❌ No active tenants found.");

    const splitAmount = amount / totalPeople;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    await Bill.updateMany({ isActive: true }, { isActive: false });

    await Bill.create({
      totalAmount: amount,
      splitAmount,
      totalPeople,
      dueDate,
      payments: [],
      isActive: true,
    });

    return safeReply(
      ctx,
      `⚡ *New Electricity Bill Created*\n\n` +
        `💰 Total: ₦${amount}\n` +
        `👥 Active Tenants: ${totalPeople}\n` +
        `💵 Per Person: ₦${splitAmount.toFixed(2)}\n` +
        `📅 Due: ${dueDate.toDateString()}`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error(error);
    safeReply(ctx, "❌ Error creating bill.");
  }
});

/* ================================
   VIEW BILL
================================ */
bot.command("bill", async (ctx) => {
  try {
    const bill = await Bill.findOne({ isActive: true });

    if (!bill)
      return safeReply(ctx, "📭 No active bill.");

    const activeUsers = await User.find({ isActive: true });

    const paidIds = bill.payments.map((p) => p.telegramId);

    const paidUsers = activeUsers.filter((u) =>
      paidIds.includes(u.telegramId)
    );

    const unpaidUsers = activeUsers.filter(
      (u) => !paidIds.includes(u.telegramId)
    );

    let message =
      `⚡ *Active Electricity Bill*\n\n` +
      `💰 Total: ₦${bill.totalAmount}\n` +
      `👥 Tenants: ${bill.totalPeople}\n` +
      `💵 Per Person: ₦${bill.splitAmount.toFixed(2)}\n` +
      `📅 Due: ${bill.dueDate.toDateString()}\n\n` +
      `📊 Progress: ${paidUsers.length}/${bill.totalPeople}\n\n`;

    message += `✅ *Paid*\n`;
    message +=
      paidUsers.length === 0
        ? "- None\n"
        : paidUsers.map((u) => `- ${u.fullName}`).join("\n");

    message += `\n\n⏳ *Pending*\n`;
    message +=
      unpaidUsers.length === 0
        ? "- None"
        : unpaidUsers.map((u) => `- ${u.fullName}`).join("\n");

    return safeReply(ctx, message, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error(error);
    safeReply(ctx, "❌ Could not fetch bill.");
  }
});

/* ================================
   INITIALIZE PAYSTACK
================================ */
async function initializePayment(email, amount, telegramId) {
  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100),
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
    console.error("Payment init error:", error.response?.data || error.message);
    return null;
  }
}

/* ================================
   PAY COMMAND
================================ */
bot.command("pay", async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();

    const user = await User.findOne({ telegramId });
    if (!user)
      return safeReply(ctx, "❌ You are not registered.");

    if (!user.isActive)
      return safeReply(
        ctx,
        "🚫 You are not active for this billing cycle."
      );

    const bill = await Bill.findOne({ isActive: true });
    if (!bill)
      return safeReply(ctx, "❌ No active bill.");

    const alreadyPaid = bill.payments.find(
      (p) => p.telegramId === telegramId
    );

    if (alreadyPaid)
      return safeReply(ctx, "✅ You already paid.");

    const paymentLink = await initializePayment(
      `${user.username || telegramId}@compound.com`,
      bill.splitAmount,
      telegramId
    );

    if (!paymentLink)
      return safeReply(ctx, "❌ Payment initialization failed.");

    try {
      await ctx.telegram.sendMessage(
        telegramId,
        `💳 Electricity Bill Payment\n\nAmount: ₦${bill.splitAmount}\n\nClick below to pay securely:`,
        Markup.inlineKeyboard([
          Markup.button.url("💰 Pay Now", paymentLink),
        ])
      );

      return safeReply(
        ctx,
        "🔒 Payment link sent privately. Check your DM."
      );
    } catch (dmError) {
      if (dmError.response?.error_code === 403) {
        return safeReply(
          ctx,
          "⚠ Open the bot privately and press START first."
        );
      }
      throw dmError;
    }
  } catch (error) {
    console.error(error);
    safeReply(ctx, "❌ Payment error.");
  }
});

/* ================================
   PAYSTACK WEBHOOK
================================ */
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
        const telegramId =
          event.data.metadata.telegramId.toString();

        const bill = await Bill.findOne({ isActive: true });
        if (!bill) return res.sendStatus(200);

        const alreadyPaid = bill.payments.find(
          (p) => p.telegramId === telegramId
        );

        if (alreadyPaid) return res.sendStatus(200);

        const user = await User.findOne({ telegramId });

        bill.payments.push({
          telegramId,
          fullName: user?.fullName || "Tenant",
          amount: event.data.amount / 100,
          reference: event.data.reference,
        });

        await bill.save();

        const paidCount = bill.payments.length;

        await bot.telegram.sendMessage(
          process.env.GROUP_ID,
          `🎉 Payment received from ${user.fullName}\nProgress: ${paidCount}/${bill.totalPeople}`
        );

        if (paidCount === bill.totalPeople) {
          bill.isActive = false;
          await bill.save();

          await bot.telegram.sendMessage(
            process.env.GROUP_ID,
            `✅ All payments completed!\n⚡ Bill CLOSED.`
          );
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Webhook error:", error);
      res.sendStatus(500);
    }
  }
);
/* ================================
   AUTO REMINDER SYSTEM
================================ */

cron.schedule("0 9 * * *", async () => {
  try {
    console.log("⏰ Running daily reminder check...");

    const bill = await Bill.findOne({ isActive: true });
    if (!bill) return;

    const activeUsers = await User.find({ isActive: true });

    const paidIds = bill.payments.map(p => p.telegramId);

    const unpaidUsers = activeUsers.filter(
      u => !paidIds.includes(u.telegramId)
    );

    if (unpaidUsers.length === 0) return;

    const daysLeft = Math.ceil(
      (bill.dueDate - new Date()) / (1000 * 60 * 60 * 24)
    );

    if (daysLeft < 0) return;

    /* =====================
       GROUP REMINDER
    ===================== */

    await bot.telegram.sendMessage(
      process.env.GROUP_ID,
      `⏰ *Electricity Bill Reminder*\n\n` +
      `💰 ₦${bill.splitAmount.toFixed(2)} per person\n` +
      `📅 Due in ${daysLeft} day(s)\n\n` +
      `⚠ ${unpaidUsers.length} tenant(s) still unpaid.\n\n` +
      `Use /pay to complete payment.`,
      { parse_mode: "Markdown" }
    );

    /* =====================
       PRIVATE REMINDERS
    ===================== */

    for (const user of unpaidUsers) {
      try {
        await bot.telegram.sendMessage(
          user.telegramId,
          `⏰ Reminder: Electricity bill of ₦${bill.splitAmount.toFixed(2)} is due in ${daysLeft} day(s).\n\nPlease use /pay to complete payment.`
        );
      } catch (err) {
        console.log("DM blocked for", user.telegramId);
      }
    }

  } catch (error) {
    console.error("Reminder error:", error);
  }
});

/* ================================
   ACTIVATE / DEACTIVATE
================================ */
bot.command("deactivate", async (ctx) => {
  if (!isAdmin(ctx))
    return safeReply(ctx, "❌ Admin only.");

  if (!ctx.message.reply_to_message)
    return safeReply(ctx, "⚠ Reply to user.");

  const telegramId =
    ctx.message.reply_to_message.from.id.toString();

  const user = await User.findOne({ telegramId });
  if (!user || user.role === "ADMIN")
    return safeReply(ctx, "❌ Cannot deactivate.");

  user.isActive = false;
  await user.save();

  safeReply(ctx, `🚫 ${user.fullName} deactivated.`);
});

bot.command("activate", async (ctx) => {
  if (!isAdmin(ctx))
    return safeReply(ctx, "❌ Admin only.");

  if (!ctx.message.reply_to_message)
    return safeReply(ctx, "⚠ Reply to user.");

  const telegramId =
    ctx.message.reply_to_message.from.id.toString();

  const user = await User.findOne({ telegramId });
  if (!user)
    return safeReply(ctx, "❌ User not found.");

  user.isActive = true;
  await user.save();

  safeReply(ctx, `✅ ${user.fullName} activated.`);
});

/* ================================
   SERVER START
================================ */
app.get("/", (req, res) =>
  res.send("🚀 Compound Utilities Bot Running")
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () =>
  console.log(`🌍 Server running on ${PORT}`)
);

bot.launch().then(() =>
  console.log("🤖 Bot running...")
);

process.once("SIGINT", () =>
  bot.stop("SIGINT")
);
process.once("SIGTERM", () =>
  bot.stop("SIGTERM")
);