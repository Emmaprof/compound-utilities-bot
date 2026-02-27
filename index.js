

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
    const telegramId = ctx.from.id;

    const user = await User.findOne({ telegramId });

    if (!user) {
      return ctx.reply("❌ You are not registered.");
    }

    const bill = await Bill.findOne({ isActive: true });

    if (!bill) {
      return ctx.reply("❌ No active bill found.");
    }

    if (bill.paidUsers.includes(user._id)) {
      return ctx.reply("✅ You have already paid for this bill.");
    }

    bill.paidUsers.push(user._id);

    // If everyone has paid, close bill
    const totalUsers = await User.countDocuments();

    if (bill.paidUsers.length === totalUsers) {
      bill.isActive = false;
      await bill.save();

      return ctx.reply(
        `🎉 Payment received from ${user.fullName}\n\n` +
        `✅ All payments completed!\n` +
        `⚡ Bill is now CLOSED.`
      );
    }

    await bill.save();

    ctx.reply(
      `💰 Payment received from ${user.fullName}\n` +
      `Progress: ${bill.paidUsers.length}/${totalUsers} paid`
    );

  } catch (error) {
    console.error(error);
    ctx.reply("❌ Error processing payment.");
  }
});
/* ------------------ BOT LAUNCH ------------------ */

bot.launch();
console.log("🚀 Bot is running...");

/* ------------------ GRACEFUL STOP ------------------ */

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));