require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.on('text', (ctx) => {
  console.log("This is your GROUP CHAT ID:", ctx.chat.id);
  ctx.reply(`Your chat ID is: ${ctx.chat.id}`);
});

bot.launch();
console.log("Bot is running, send any message in the group...");