const mongoose = require('mongoose');
const { isValidEmail } = require('../utils/email');
const bcrypt = require('bcryptjs');
const { hashPassword, BCRYPT_HASH_RE } = require('../utils/password');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      validate: { validator: isValidEmail, message: 'Enter a valid email address' },
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    role: {
      type: String,
      enum: ['owner', 'manager'],
      default: 'owner',
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    emailVerifiedAt: {
      type: Date,
      default: Date.now,
    },
    permissions: {
      canSpendCredits: {
        type: Boolean,
        default: false,
      },
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
    },
    cafeIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cafe',
      },
    ],
    activeCafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

userSchema.index({ orgId: 1 });

userSchema.pre('save', async function hashChangedPassword(next) {
  if (!this.isModified('password')) return next();
  // verifyEmail stores the hash taken at registration; hashing it again would lock the owner out (identity-13).
  if (this.$locals.passwordIsHash) {
    if (!BCRYPT_HASH_RE.test(this.password)) return next(new Error('A pre-hashed password must be a bcrypt hash'));
    return next();
  }
  this.password = await hashPassword(this.password);
  return next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  // A non-string reaching bcrypt throws, which used to turn a login into a 500 only for real accounts (identity-12).
  if (typeof candidatePassword !== 'string' || !this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
