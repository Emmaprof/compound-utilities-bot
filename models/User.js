const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    telegramId: {
        type: String, // Stored as a string to prevent JS integer overflow
        required: true,
        unique: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    username: {
        type: String,
        default: ""
    },
    fullName: {
        type: String,
        default: ""
    },
    role: {
        type: String,
        enum: ['ADMIN', 'TENANT'],
        default: 'TENANT'
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);