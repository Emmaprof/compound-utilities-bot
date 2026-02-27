

// Start command
// bot.start((ctx) => {
//     ctx.reply("⚡ Welcome to No. 10 Asuquo Ibanga Utilities Council Bot!");
// });
require('dotenv').config();

const { Telegraf } = require('telegraf');
const connectDB = require('./config/db');
const User = require('./models/User');
const Bill = require('./models/Bill');
const Payment = require('./models/Payment');
const axios = require('axios');

connectDB();

const bot = new Telegraf(process.env.BOT_TOKEN);

/* ------------------ UTILITIES ------------------ */

const isAdmin = (ctx) => {
    return ctx.from.id.toString() === process.env.ADMIN_ID;
};

const handleError = (ctx, error) => {
    console.error(error);
    ctx.reply("❌ Something went wrong. Please try again.");
};

/* ------------------ START COMMAND ------------------ */

bot.start(async (ctx) => {
    try {
        const telegramId = ctx.from.id.toString();

        let user = await User.findOne({ telegramId });

        if (!user) {
            user = await User.create({
                telegramId,
                username: ctx.from.username || "",
                fullName: `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim(),
                role: telegramId === process.env.ADMIN_ID ? 'ADMIN' : 'TENANT'
            });

            return ctx.reply(`✅ Registered successfully as ${user.role}`);
        }

        ctx.reply(`👋 Welcome back, ${user.fullName}\nRole: ${user.role}`);
    } catch (error) {
        handleError(ctx, error);
    }
});

/* ------------------ REGISTER TENANT ------------------ */

bot.command('register', async (ctx) => {
    try {
        if (!isAdmin(ctx)) {
            return ctx.reply("❌ Only ADMIN can register tenants.");
        }

        if (!ctx.message.reply_to_message) {
            return ctx.reply("⚠ Reply to the tenant's message with /register");
        }

        const mentionedUser = ctx.message.reply_to_message.from;
        const telegramId = mentionedUser.id.toString();

        const existing = await User.findOne({ telegramId });

        if (existing) {
            return ctx.reply("⚠ User already registered.");
        }

        await User.create({
            telegramId,
            username: mentionedUser.username || "",
            fullName: `${mentionedUser.first_name || ""} ${mentionedUser.last_name || ""}`.trim(),
            role: "TENANT"
        });

        ctx.reply(`✅ ${mentionedUser.first_name} registered successfully as TENANT`);
    } catch (error) {
        handleError(ctx, error);
    }
});

/* ------------------ REMOVE TENANT ------------------ */

bot.command('remove', async (ctx) => {
    try {
        if (!isAdmin(ctx)) {
            return ctx.reply("❌ Only ADMIN can remove tenants.");
        }

        if (!ctx.message.reply_to_message) {
            return ctx.reply("⚠ Reply to the tenant's message with /remove");
        }

        const mentionedUser = ctx.message.reply_to_message.from;
        const telegramId = mentionedUser.id.toString();

        const user = await User.findOne({ telegramId });

        if (!user) {
            return ctx.reply("⚠ User not found in system.");
        }

        if (user.role === "ADMIN") {
            return ctx.reply("❌ Cannot remove ADMIN.");
        }

        await User.deleteOne({ telegramId });

        ctx.reply(`🗑 ${mentionedUser.first_name} removed from system.`);
    } catch (error) {
        handleError(ctx, error);
    }
});

/* ------------------ LIST TENANTS ------------------ */

bot.command('tenants', async (ctx) => {
    try {
        if (!isAdmin(ctx)) {
            return ctx.reply("❌ Only ADMIN can view tenants.");
        }

        const tenants = await User.find({ role: "TENANT" }).sort({ createdAt: 1 });

        if (tenants.length === 0) {
            return ctx.reply("No tenants registered yet.");
        }

        let message = "🏠 Registered Tenants:\n\n";

        tenants.forEach((tenant, index) => {
            message += `${index + 1}. ${tenant.fullName}\n`;
        });

        ctx.reply(message);
    } catch (error) {
        handleError(ctx, error);
    }
});
// 
async function initializePayment(email, amount, telegramId) {
  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email,
        amount: amount * 100, // convert to kobo
        metadata: {
          telegramId
        },
        callback_url: `${process.env.BASE_URL}/payment-success`
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return response.data.data.authorization_url;

  } catch (error) {
    console.error("Payment init error:", error.response?.data || error.message);
    return null;
  }
}

// newbill

bot.command('newbill', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Only ADMIN can create bills.");
    }

    const parts = ctx.message.text.split(" ");
    const amount = parseFloat(parts[1]);

    if (!amount || amount <= 0) {
      return ctx.reply("❌ Usage: /newbill 120000");
    }

    const users = await User.find();
    const totalPeople = users.length;

    if (totalPeople === 0) {
      return ctx.reply("❌ No registered users found.");
    }

    const splitAmount = amount / totalPeople;

    // Set due date to 7 days from now
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    const bill = await Bill.create({
      totalAmount: amount,
      splitAmount: splitAmount,
      dueDate: dueDate,
      paidUsers: [],
      isActive: true
    });

    ctx.reply(
      `⚡ New Electricity Bill Created!\n\n` +
      `Total Amount: ₦${amount}\n` +
      `Total People: ${totalPeople}\n` +
      `Per Person: ₦${splitAmount.toFixed(2)}\n` +
      `Due Date: ${dueDate.toDateString()}\n\n` +
      `Please make your payment before due date.`
    );

  } catch (error) {
    console.error(error);
    ctx.reply("❌ Error creating bill.");
  }
});

//Pay command

bot.command('pay', async (ctx) => {
  try {
    const user = await User.findOne({ telegramId: ctx.from.id });

    if (!user) {
      return ctx.reply("❌ You are not registered.");
    }

    const activeBill = await Bill.findOne({ isActive: true });

    if (!activeBill) {
      return ctx.reply("❌ No active bill.");
    }

    if (activeBill.paidUsers.includes(user.telegramId.toString())) {
      return ctx.reply("✅ You already paid.");
    }

    const paymentLink = await initializePayment(
      `${user.username || user.telegramId}@compound.com`,
      activeBill.splitAmount,
      user.telegramId
    );

    if (!paymentLink) {
      return ctx.reply("❌ Could not generate payment link.");
    }

    await ctx.telegram.sendMessage(
      ctx.from.id,
      `💳 Please complete your payment:\n\n${paymentLink}`
    );

    ctx.reply("📩 Payment link sent to your DM.");

  } catch (error) {
    console.error(error);
    ctx.reply("❌ Something went wrong.");
  }
});
/* ------------------ BOT LAUNCH ------------------ */

// bot.launch();
// console.log("🚀 Bot is running...");
//express server for webhook and health check
app.post('/paystack-webhook', express.json(), async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;

  const hash = crypto
    .createHmac('sha512', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (hash !== req.headers['x-paystack-signature']) {
    return res.status(401).send('Unauthorized');
  }

  const event = req.body;

  if (event.event === 'charge.success') {
    const telegramId = event.data.metadata.telegramId;

    const bill = await Bill.findOne({ isActive: true });
    if (!bill) return res.sendStatus(200);

    if (!bill.paidUsers.includes(telegramId.toString())) {
      bill.paidUsers.push(telegramId.toString());
      await bill.save();

      const user = await User.findOne({ telegramId });

      await bot.telegram.sendMessage(
        process.env.GROUP_ID,
        `✅ @${user.username || user.fullName} has successfully paid ₦${bill.splitAmount}`
      );
    }
  }

  res.sendStatus(200);
});

const express = require("express");
const bodyParser = require("body-parser");

const app = express();

// Important: raw body needed later for Paystack signature verification
app.use(bodyParser.json());

// Health check route (Render requirement)
app.get("/", (req, res) => {
  res.send("🚀 Compound Utilities Bot is running.");
});

// Start Express server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌍 Server running on port ${PORT}`);
});

// Launch Telegram bot
bot.launch().then(() => {
  console.log("🤖 Telegram Bot is running...");
});

/* ------------------ GRACEFUL STOP ------------------ */

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));