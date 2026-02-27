const mongoose = require('mongoose');

const billSchema = new mongoose.Schema({
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
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        }
    ],
    isActive: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('Bill', billSchema);