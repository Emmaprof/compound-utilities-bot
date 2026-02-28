const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    telegramId: {
        type: String,
        required: true,
        unique: true
    },
    isActive: {
        type: Boolean,
        default: true
        },
    username: String,
    fullName: String,
    role: {
        type: String,
        enum: ['ADMIN', 'TENANT'],
        default: 'TENANT'
    }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);