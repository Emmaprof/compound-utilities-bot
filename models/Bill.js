const mongoose = require('mongoose');

const billSchema = new mongoose.Schema({
    totalPeople: {
    type: Number,
    required: true
    },
    totalAmount: {
        type: Number,
        required: true
    },
    splitAmount: {
        type: Number,
        required: true
    },
    dueDate: {
        type: Date,
        required: true
    },
    paidUsers: [
    {
    type: String
    }
    ],
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('Bill', billSchema);