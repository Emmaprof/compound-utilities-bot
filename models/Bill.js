const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  telegramId: { type: String, required: true },
  fullName: { type: String, default: "" },
  amount: { type: Number, required: true },
  reference: { type: String, required: true },
  paidAt: { type: Date, default: Date.now },
});

const billSchema = new mongoose.Schema(
  {
    totalAmount: { type: Number, required: true },
    splitAmount: { type: Number, required: true },
    totalPeople: { type: Number, required: true },
    dueDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    lateFeeApplied: { type: Boolean, default: false },
    billedTenants: [{ type: String, required: true }], // STRICT array of strings
    payments: [paymentSchema], // Embedded payments
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bill", billSchema);