require("dotenv").config();

const { Telegraf } = require("telegraf");
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");


const connectDB = require("./config/db");
const User = require("./models/User");
const Bill = require("./models/Bill");

connectDB();

/* ================================
   INITIALIZE TELEGRAM BOT
================================ */
const bot = new Telegraf(process.env.BOT_TOKEN);

/* ================================
   INITIALIZE EXPRESS APP
================================ */
const app = express();

/* ================================
   UTILITIES
================================ */
const isAdmin = (ctx) =>
  ctx.from.id.toString() === process.env.ADMIN_ID;

const handleError = (ctx, error) => {
  console.error(error);
  ctx.reply("❌ Something went wrong. Please try again.");
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
        fullName: `${ctx.from.first_name || ""} ${
          ctx.from.last_name || ""
        }`.trim(),
        role:
          telegramId === process.env.ADMIN_ID
            ? "ADMIN"
            : "TENANT",
      });

      return ctx.reply(
        `✅ Registered successfully as ${user.role}`
      );
    }

    ctx.reply(
      `👋 Welcome back, ${user.fullName}\nRole: ${user.role}`
    );
  } catch (error) {
    handleError(ctx, error);
  }
});

/* ================================
   REGISTER TENANT
================================ */
bot.command("register", async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply(
        "❌ Only ADMIN can register tenants."
      );
    }

    if (!ctx.message.reply_to_message) {
      return ctx.reply(
        "⚠ Reply to the tenant's message with /register"
      );
    }

    const mentionedUser =
      ctx.message.reply_to_message.from;

    const telegramId =
      mentionedUser.id.toString();

    const existing = await User.findOne({
      telegramId,
    });

    if (existing) {
      return ctx.reply(
        "⚠ User already registered."
      );
    }

    await User.create({
      telegramId,
      username: mentionedUser.username || "",
      fullName: `${mentionedUser.first_name || ""} ${
        mentionedUser.last_name || ""
      }`.trim(),
      role: "TENANT",
    });

    ctx.reply(
      `✅ ${mentionedUser.first_name} registered successfully`
    );
  } catch (error) {
    handleError(ctx, error);
  }
});

/* ================================
   NEW BILL
================================ */
bot.command("newbill", async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      return ctx.reply("❌ Only ADMIN can create bills.");
    }

    const parts = ctx.message.text.split(" ");

    const amount = parseFloat(parts[1]);
    const customCount = parts[2] ? parseInt(parts[2]) : null;

    if (!amount || amount <= 0) {
      return ctx.reply("❌ Usage: /newbill 120000 10");
    }

    const totalRegisteredUsers = await User.countDocuments();

    if (totalRegisteredUsers === 0) {
      return ctx.reply("❌ No registered users found.");
    }

    let totalPeople;

    if (customCount) {
      if (customCount <= 0) {
        return ctx.reply("❌ Number of tenants must be greater than 0.");
      }

      if (customCount > totalRegisteredUsers) {
        return ctx.reply(
          `❌ You only have ${totalRegisteredUsers} registered users.`
        );
      }

      totalPeople = customCount;
    } else {
      totalPeople = totalRegisteredUsers;
    }

    const splitAmount = amount / totalPeople;

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 7);

    // Close any previous active bill
    await Bill.updateMany({ isActive: true }, { isActive: false });

    await Bill.create({
      totalAmount: amount,
      splitAmount,
      totalPeople,
      dueDate,
      paidUsers: [],
      isActive: true,
    });

    ctx.reply(
      `⚡ New Electricity Bill Created!\n\n` +
        `Total Amount: ₦${amount}\n` +
        `People Sharing: ${totalPeople}\n` +
        `Per Person: ₦${splitAmount.toFixed(2)}\n` +
        `Due Date: ${dueDate.toDateString()}\n\n` +
        `Please make your payment before due date.`
    );
  } catch (error) {
    console.error(error);
    ctx.reply("❌ Error creating bill.");
  }
});

/* ================================
   INITIALIZE PAYSTACK PAYMENT
================================ */
async function initializePayment(
  email,
  amount,
  telegramId
) {
  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: amount * 100,
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
    console.error(
      "Payment init error:",
      error.response?.data || error.message
    );
    return null;
  }
}

/* ================================
   PAY COMMAND
================================ */
const { Markup } = require('telegraf');

bot.command('pay', async (ctx) => {
  try {
    const telegramId = ctx.from.id.toString();
    const user = await User.findOne({ telegramId });

    if (!user) {
      return ctx.reply("❌ You are not registered.");
    }

    const activeBill = await Bill.findOne({ isActive: true });

    if (!activeBill) {
      return ctx.reply("❌ No active bill.");
    }

    if (activeBill.paidUsers.includes(telegramId)) {
      return ctx.reply("✅ You already paid.");
    }

    const paymentLink = await initializePayment(
      `${user.username || telegramId}@compound.com`,
      activeBill.splitAmount,
      telegramId
    );

    if (!paymentLink) {
      return ctx.reply("❌ Could not generate payment link.");
    }

    // Send button privately
    await ctx.telegram.sendMessage(
      telegramId,
      `💳 Electricity Bill Payment\n\nAmount: ₦${activeBill.splitAmount}\n\nClick below to pay securely:`,
      Markup.inlineKeyboard([
        [Markup.button.url("💰 Pay Now", paymentLink)]
      ])
    );

    // Clean group confirmation
    await ctx.reply(
  "🔒 For security, your payment link has been sent privately.\n\nPlease check your messages."
);

  } catch (error) {
    console.error(error);
    ctx.reply("❌ Something went wrong.");
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
      const secret =
        process.env.PAYSTACK_SECRET_KEY;

      const hash = crypto
        .createHmac("sha512", secret)
        .update(req.body)
        .digest("hex");

      if (
        hash !==
        req.headers["x-paystack-signature"]
      ) {
        return res
          .status(401)
          .send("Unauthorized");
      }

      const event = JSON.parse(
        req.body.toString()
      );

      if (
        event.event === "charge.success"
      ) {
        const telegramId =
          event.data.metadata.telegramId.toString();

        const bill =
          await Bill.findOne({
            isActive: true,
          });

        if (!bill)
          return res.sendStatus(200);

        if (
          !bill.paidUsers.includes(
            telegramId
          )
        ) {
          bill.paidUsers.push(
            telegramId
          );
          await bill.save();

          const totalUsers = 
          bill.totalPeople;

          const user =
            await User.findOne({
              telegramId,
            });

          await bot.telegram.sendMessage(
            process.env.GROUP_ID,
            `🎉 Payment received from ${user.fullName}\n\nProgress: ${bill.paidUsers.length}/${totalUsers} paid`
          );

          if (
            bill.paidUsers.length ===
            totalUsers
          ) {
            bill.isActive = false;
            await bill.save();

            await bot.telegram.sendMessage(
              process.env.GROUP_ID,
              `\n✅ All payments completed!\n⚡ Bill is now CLOSED.`
            );
          }
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error(
        "Webhook error:",
        error
      );
      res.sendStatus(500);
    }
  }
);

/* ================================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.send(
    "🚀 Compound Utilities Bot is running."
  );
});

/* ================================
   START SERVER & BOT
================================ */
const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(
    `🌍 Server running on port ${PORT}`
  );
});

bot.launch().then(() => {
  console.log(
    "🤖 Telegram Bot is running..."
  );
});

/* ================================
   GRACEFUL SHUTDOWN
================================ */
process.once("SIGINT", () =>
  bot.stop("SIGINT")
);
process.once("SIGTERM", () =>
  bot.stop("SIGTERM")
);