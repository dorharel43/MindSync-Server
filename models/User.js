const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// One document per person using the app. Replaces the old singleton
// "Profile" settings document - name/degree live here now, so there's one
// less collection and one less place they can drift out of sync.
const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [true, 'Email is required'],
        trim: true,
        lowercase: true,
        unique: true,
        match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'That does not look like a valid email']
    },
    // Never store or return the plain password. select:false means a normal
    // User.find() / findById() will NOT include this field unless a query
    // explicitly asks for it with .select('+passwordHash') - which matters
    // because the password hash is exactly the kind of thing that ends up
    // leaking through an API response by accident otherwise.
    passwordHash: {
        type: String,
        required: true,
        select: false
    },
    name: { type: String, default: '', trim: true, maxlength: 100 },
    degree: { type: String, default: '', trim: true, maxlength: 100 }
}, {
    timestamps: true
});

// Hashes happen here, not in the route handler, so there is exactly one
// place in the whole app that can create a User document with a plain-text
// password field - every other caller goes through this method or never
// touches passwordHash at all.
userSchema.methods.setPassword = async function (plainPassword) {
    const SALT_ROUNDS = 12;
    this.passwordHash = await bcrypt.hash(plainPassword, SALT_ROUNDS);
};

userSchema.methods.checkPassword = function (plainPassword) {
    return bcrypt.compare(plainPassword, this.passwordHash);
};

module.exports = mongoose.model('User', userSchema);