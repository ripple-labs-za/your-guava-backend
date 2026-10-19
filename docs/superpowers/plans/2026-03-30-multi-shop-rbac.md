# Multi-Shop & RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a single owner to manage multiple cafes under one account, and invite managers with restricted access to specific cafes.

**Architecture:** Introduce an Organization layer between User and Cafe. Users have a `role` (owner or manager) and an array of `cafeIds` they can access. Owners see all cafes in their org and can switch between them. Managers only see cafes they're assigned to. The JWT token includes the user's role and current active cafeId. A cafe switcher in the portal sidebar lets users switch context.

**Tech Stack:** MongoDB/Mongoose (backend), React + TypeScript (portal), JWT with role claims

---

## Current State

- **User** has a single `cafeId` field (ObjectId)
- **Cafe** has an `ownerId` field
- **JWT** contains `{ id, cafeId }` — hardcoded to one cafe
- **Auth controller** creates one cafe per registration
- **All endpoints** use `req.user.cafeId` to scope data
- **Portal** has no concept of switching cafes or user roles

## Data Model Changes

### User (modified)
```
email, password, name (unchanged)
role: 'owner' | 'manager' (NEW)
orgId: ObjectId ref Organization (NEW)
cafeIds: [ObjectId] (NEW — replaces single cafeId)
activeCafeId: ObjectId (NEW — currently selected cafe)
cafeId: REMOVE (replaced by activeCafeId)
```

### Organization (NEW)
```
name: String (e.g. "Schoeman Coffee Group")
ownerId: ObjectId ref User
plan: String (default 'free')
createdAt, updatedAt
```

### Cafe (modified)
```
orgId: ObjectId ref Organization (NEW — replaces ownerId)
ownerId: REMOVE (org owns cafes now)
everything else unchanged
```

### JWT payload changes
```
Before: { id, cafeId }
After:  { id, cafeId, role, orgId }
```

---

## Task Breakdown

### Task 1: Create Organization Model

**Files:**
- Create: `src/models/Organization.model.js`

- [ ] **Step 1: Create Organization model**

```js
// src/models/Organization.model.js
const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: String,
      enum: ['free', 'growth', 'pro'],
      default: 'free',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
```

- [ ] **Step 2: Commit**

```bash
git add src/models/Organization.model.js
git commit -m "feat: add Organization model"
```

---

### Task 2: Update User Model with Role & Multi-Cafe

**Files:**
- Modify: `src/models/User.model.js`

- [ ] **Step 1: Update User schema**

Replace the `cafeId` field and add `role`, `orgId`, `cafeIds`, `activeCafeId`:

```js
// src/models/User.model.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    name: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'manager'],
      default: 'owner',
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
    refreshTokens: [
      {
        token: { type: String },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
```

- [ ] **Step 2: Commit**

```bash
git add src/models/User.model.js
git commit -m "feat: add role, orgId, cafeIds, activeCafeId to User model"
```

---

### Task 3: Update Cafe Model — Replace ownerId with orgId

**Files:**
- Modify: `src/models/Cafe.model.js`

- [ ] **Step 1: Replace ownerId with orgId**

```js
// src/models/Cafe.model.js — change ownerId to orgId
// Line 9-12: replace ownerId block with:
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
```

- [ ] **Step 2: Commit**

```bash
git add src/models/Cafe.model.js
git commit -m "feat: replace ownerId with orgId on Cafe model"
```

---

### Task 4: Update Auth Controller — Registration Creates Org + Supports Roles

**Files:**
- Modify: `src/controllers/auth.controller.js`

- [ ] **Step 1: Update register to create Organization**

Update the `register` function. Import Organization model. On registration: create User → create Organization → create Cafe → link all three.

```js
// At top of file, add:
const Organization = require('../models/Organization.model');

// Replace generateTokens to include role and orgId:
const generateTokens = (userId, cafeId, role, orgId) => {
  const accessToken = jwt.sign(
    {
      id: userId,
      cafeId: cafeId ? cafeId.toString() : null,
      role: role || 'owner',
      orgId: orgId ? orgId.toString() : null,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );

  const refreshToken = jwt.sign(
    { id: userId },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

// Replace register function:
const register = async (req, res, next) => {
  try {
    const { email, password, name, cafeName, orgName } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ success: false, message: 'Email, password, and name are required' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Create user first (owner by default)
    const user = await User.create({ email, password, name, role: 'owner' });

    // Create organization
    const org = await Organization.create({
      name: orgName || `${name}'s Organization`,
      ownerId: user._id,
    });

    // Create first cafe
    const cafe = await Cafe.create({
      name: cafeName || 'My Cafe',
      orgId: org._id,
    });

    // Link user to org and cafe
    user.orgId = org._id;
    user.cafeIds = [cafe._id];
    user.activeCafeId = cafe._id;

    const { accessToken, refreshToken } = generateTokens(user._id, cafe._id, 'owner', org._id);

    user.refreshTokens.push({ token: refreshToken });
    await user.save();

    const cookieOptions = {
      ...COOKIE_OPTIONS,
      secure: process.env.NODE_ENV === 'production',
    };

    res.cookie('refreshToken', refreshToken, cookieOptions);

    return res.status(201).json({
      success: true,
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: org._id,
        cafeIds: user.cafeIds,
        activeCafeId: cafe._id,
      },
    });
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 2: Update login to return role, orgId, cafeIds**

```js
// In login function, update the response to include new fields:
return res.status(200).json({
  success: true,
  accessToken,
  user: {
    id: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    orgId: user.orgId,
    cafeIds: user.cafeIds,
    activeCafeId: user.activeCafeId,
  },
});
```

Also update the `generateTokens` call in login:
```js
const { accessToken, refreshToken } = generateTokens(user._id, user.activeCafeId, user.role, user.orgId);
```

- [ ] **Step 3: Update refresh to include role/orgId in new access token**

```js
// In refresh function, update the access token generation:
const accessToken = jwt.sign(
  {
    id: user._id,
    cafeId: user.activeCafeId ? user.activeCafeId.toString() : null,
    role: user.role || 'owner',
    orgId: user.orgId ? user.orgId.toString() : null,
  },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
);
```

- [ ] **Step 4: Update me endpoint to return full user data**

```js
const me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password -refreshTokens');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      cafeIds: user.cafeIds,
      activeCafeId: user.activeCafeId,
    });
  } catch (error) {
    next(error);
  }
};
```

- [ ] **Step 5: Commit**

```bash
git add src/controllers/auth.controller.js
git commit -m "feat: auth supports org, roles, multi-cafe"
```

---

### Task 5: Add RBAC Middleware

**Files:**
- Create: `src/middleware/rbac.middleware.js`

- [ ] **Step 1: Create role-based access middleware**

```js
// src/middleware/rbac.middleware.js

// Requires specific role(s)
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }
    next();
  };
};

// Requires owner role
const ownerOnly = requireRole('owner');

// Allows both owner and manager
const authenticated = requireRole('owner', 'manager');

module.exports = { requireRole, ownerOnly, authenticated };
```

- [ ] **Step 2: Commit**

```bash
git add src/middleware/rbac.middleware.js
git commit -m "feat: add RBAC middleware (ownerOnly, authenticated)"
```

---

### Task 6: Add Cafe Switching & Manager Invite Endpoints

**Files:**
- Create: `src/controllers/team.controller.js`
- Create: `src/routes/team.routes.js`
- Modify: `src/app.js`

- [ ] **Step 1: Create team controller**

```js
// src/controllers/team.controller.js
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const crypto = require('crypto');

// POST /api/team/invite — Owner invites a manager
const inviteManager = async (req, res, next) => {
  try {
    const { email, name, password, cafeIds } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ success: false, message: 'Email, name, and password are required' });
    }

    // Verify requester is owner
    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can invite managers' });
    }

    // Check email not taken
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Validate cafeIds belong to owner's org
    const orgCafes = await Cafe.find({ orgId: owner.orgId }).select('_id');
    const orgCafeIds = orgCafes.map((c) => c._id.toString());
    const validCafeIds = (cafeIds || []).filter((id) => orgCafeIds.includes(id));

    if (validCafeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid cafe must be assigned' });
    }

    // Create manager user
    const manager = await User.create({
      email,
      name,
      password,
      role: 'manager',
      orgId: owner.orgId,
      cafeIds: validCafeIds,
      activeCafeId: validCafeIds[0],
    });

    return res.status(201).json({
      success: true,
      manager: {
        id: manager._id,
        email: manager.email,
        name: manager.name,
        role: manager.role,
        cafeIds: manager.cafeIds,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/team — List all team members in the org
const listTeam = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    const members = await User.find({ orgId: user.orgId })
      .select('name email role cafeIds activeCafeId createdAt')
      .populate('cafeIds', 'name')
      .lean();

    return res.status(200).json({ success: true, members });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/team/:userId — Owner removes a manager
const removeMember = async (req, res, next) => {
  try {
    const owner = await User.findById(req.user.id);
    const target = await User.findById(req.params.userId);

    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (target.orgId.toString() !== owner.orgId.toString()) {
      return res.status(403).json({ success: false, message: 'User not in your organization' });
    }

    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'Cannot remove the owner' });
    }

    await User.findByIdAndDelete(target._id);

    return res.status(200).json({ success: true, message: 'Member removed' });
  } catch (error) {
    next(error);
  }
};

// PUT /api/team/:userId/cafes — Owner updates a manager's cafe access
const updateMemberCafes = async (req, res, next) => {
  try {
    const { cafeIds } = req.body;
    const owner = await User.findById(req.user.id);
    const target = await User.findById(req.params.userId);

    if (!target || target.orgId.toString() !== owner.orgId.toString()) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Validate cafeIds belong to org
    const orgCafes = await Cafe.find({ orgId: owner.orgId }).select('_id');
    const orgCafeIds = orgCafes.map((c) => c._id.toString());
    const validCafeIds = (cafeIds || []).filter((id) => orgCafeIds.includes(id));

    target.cafeIds = validCafeIds;
    if (!validCafeIds.includes(target.activeCafeId?.toString())) {
      target.activeCafeId = validCafeIds[0] || null;
    }
    await target.save();

    return res.status(200).json({ success: true, cafeIds: target.cafeIds });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/switch-cafe — Switch active cafe
const switchCafe = async (req, res, next) => {
  try {
    const { cafeId } = req.body;
    const user = await User.findById(req.user.id);

    if (!user.cafeIds.map((id) => id.toString()).includes(cafeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this cafe' });
    }

    user.activeCafeId = cafeId;
    await user.save();

    // Generate new tokens with updated cafeId
    const jwt = require('jsonwebtoken');
    const accessToken = jwt.sign(
      {
        id: user._id,
        cafeId: cafeId,
        role: user.role,
        orgId: user.orgId ? user.orgId.toString() : null,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );

    return res.status(200).json({ success: true, accessToken, activeCafeId: cafeId });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/add-cafe — Owner adds a new cafe to the org
const addCafe = async (req, res, next) => {
  try {
    const { name, address, city, lat, lng } = req.body;
    const owner = await User.findById(req.user.id);

    if (!name) {
      return res.status(400).json({ success: false, message: 'Cafe name is required' });
    }

    const cafe = await Cafe.create({
      name,
      orgId: owner.orgId,
      location: { address, city: city || 'Cape Town', lat, lng },
    });

    // Add to owner's cafeIds
    owner.cafeIds.push(cafe._id);
    await owner.save();

    return res.status(201).json({ success: true, cafe });
  } catch (error) {
    next(error);
  }
};

module.exports = { inviteManager, listTeam, removeMember, updateMemberCafes, switchCafe, addCafe };
```

- [ ] **Step 2: Create team routes**

```js
// src/routes/team.routes.js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  inviteManager,
  listTeam,
  removeMember,
  updateMemberCafes,
  switchCafe,
  addCafe,
} = require('../controllers/team.controller');

router.use(authMiddleware);

// Any authenticated user can switch cafe
router.post('/switch-cafe', switchCafe);

// Owner-only endpoints
router.get('/', ownerOnly, listTeam);
router.post('/invite', ownerOnly, inviteManager);
router.delete('/:userId', ownerOnly, removeMember);
router.put('/:userId/cafes', ownerOnly, updateMemberCafes);
router.post('/add-cafe', ownerOnly, addCafe);

module.exports = router;
```

- [ ] **Step 3: Mount team routes in app.js**

Add to `src/app.js`:
```js
const teamRoutes = require('./routes/team.routes');
// After existing route mounts:
app.use('/api/team', teamRoutes);
```

- [ ] **Step 4: Commit**

```bash
git add src/controllers/team.controller.js src/routes/team.routes.js src/app.js
git commit -m "feat: team management — invite managers, switch cafes, add cafes"
```

---

### Task 7: Update Seed Script for Multi-Shop

**Files:**
- Modify: `src/seed.js` or `src/seed.js`

- [ ] **Step 1: Update seed.js to create Organization**

Add Organization creation between User and Cafe creation. Update User to have role, orgId, cafeIds, activeCafeId. Update Cafe to use orgId instead of ownerId.

```js
// After user creation, before cafe creation:
const Organization = require('./models/Organization.model');

// ... inside seed():
const org = await Organization.create({
  name: "Schoeman Coffee Group",
  ownerId: user._id,
});

// Update cafe creation:
const cafe = await Cafe.create({
  name: 'Blouberg Coffee',
  orgId: org._id,  // was: ownerId: user._id
  location: { ... },
  ...
});

// Update user fields:
user.role = 'owner';
user.orgId = org._id;
user.cafeIds = [cafe._id];
user.activeCafeId = cafe._id;
await user.save();
```

- [ ] **Step 2: Commit**

```bash
git add src/seed.js
git commit -m "feat: seed script creates organization"
```

---

### Task 8: Portal — Update Types for Multi-Shop & RBAC

**Files:**
- Modify: `src/types/index.ts` (portal)

- [ ] **Step 1: Update User and add Organization types**

```ts
export interface User {
  id: string
  email: string
  name: string
  role: 'owner' | 'manager'
  orgId: string
  cafeIds: string[]
  activeCafeId: string
}

export interface Organization {
  _id: string
  name: string
  ownerId: string
  plan: 'free' | 'growth' | 'pro'
}

export interface TeamMember {
  _id: string
  name: string
  email: string
  role: 'owner' | 'manager'
  cafeIds: { _id: string; name: string }[]
  createdAt: string
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: portal types for multi-shop and RBAC"
```

---

### Task 9: Portal — Cafe Switcher in Sidebar

**Files:**
- Modify: `src/components/layout/Sidebar.tsx` (portal)

- [ ] **Step 1: Add cafe switcher dropdown**

After the logo section and before the nav, add a cafe selector dropdown. Fetch all cafes the user has access to via the existing cafe data. When a cafe is selected, call `POST /api/team/switch-cafe` and update the auth context with the new token.

The switcher should:
- Show current cafe name
- Dropdown with all accessible cafes
- On select: POST /api/team/switch-cafe → receive new accessToken → store it → reload page data
- Only show if user has more than 1 cafe

- [ ] **Step 2: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat: cafe switcher in sidebar"
```

---

### Task 10: Portal — Team Management Page (Owner Only)

**Files:**
- Create: `src/pages/Team.tsx` (portal)
- Modify: `src/App.tsx` — add /team route
- Modify: `src/components/layout/Sidebar.tsx` — add Team nav item (owner only)

- [ ] **Step 1: Create Team page**

Page shows:
- List of team members (name, email, role badge, assigned cafes)
- "Invite Manager" form (email, name, cafe selection checkboxes); the manager chooses a password from the single-use email link
- Remove button per manager
- "Add Cafe" button for owner to add a new shop

Endpoints used:
- `GET /api/team` — list members
- `POST /api/team/invite` — invite manager
- `DELETE /api/team/:userId` — remove member
- `POST /api/team/add-cafe` — add new cafe

- [ ] **Step 2: Add route and nav item**

In `App.tsx`, add protected route for `/team`.
In `Sidebar.tsx`, add "Team" nav item with `Users` icon — only show when `user.role === 'owner'`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Team.tsx src/App.tsx src/components/layout/Sidebar.tsx
git commit -m "feat: team management page with invite, remove, add cafe"
```

---

### Task 11: Update AuthContext for Multi-Shop

**Files:**
- Modify: `src/contexts/AuthContext.tsx` (portal)

- [ ] **Step 1: Update auth context**

- Store full user object including `role`, `orgId`, `cafeIds`, `activeCafeId`
- Add `switchCafe(cafeId)` function that calls `POST /api/team/switch-cafe`, updates accessToken, and triggers a page data reload
- Expose `isOwner` computed boolean

- [ ] **Step 2: Commit**

```bash
git add src/contexts/AuthContext.tsx
git commit -m "feat: auth context supports multi-cafe switching and roles"
```

---

### Task 12: Data Migration Script

**Files:**
- Create: `src/migrations/add-orgs.js`

- [ ] **Step 1: Create migration for existing data**

Script that:
1. Finds all existing users
2. For each user with role undefined, set role = 'owner'
3. Creates an Organization for each owner
4. Updates their cafes to use orgId instead of ownerId
5. Sets cafeIds and activeCafeId on the user

```js
// src/migrations/add-orgs.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected');

  const users = await User.find({ role: { $exists: false } });
  console.log(`Found ${users.length} users to migrate`);

  for (const user of users) {
    // Create org
    const org = await Organization.create({
      name: `${user.name}'s Organization`,
      ownerId: user._id,
    });

    // Find user's cafes (by old ownerId field)
    const cafes = await Cafe.find({ ownerId: user._id });

    // Update cafes to use orgId
    for (const cafe of cafes) {
      cafe.orgId = org._id;
      await cafe.save();
    }

    // Update user
    user.role = 'owner';
    user.orgId = org._id;
    user.cafeIds = cafes.map((c) => c._id);
    user.activeCafeId = cafes[0]?._id || null;
    await user.save();

    console.log(`Migrated ${user.email}: org=${org.name}, cafes=${cafes.length}`);
  }

  // Also handle cafes that might have been found by the old cafeId field
  const usersWithOldCafeId = await User.find({ cafeId: { $exists: true }, activeCafeId: { $exists: false } });
  for (const user of usersWithOldCafeId) {
    if (!user.activeCafeId && user.cafeId) {
      user.activeCafeId = user.cafeId;
      user.cafeIds = [user.cafeId];
      await user.save();
      console.log(`Fixed ${user.email}: set activeCafeId from old cafeId`);
    }
  }

  console.log('Migration complete');
  await mongoose.disconnect();
  process.exit(0);
}

migrate().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add src/migrations/add-orgs.js
git commit -m "feat: migration script to add orgs to existing data"
```

---

## Execution Order

1. Task 1 — Organization model
2. Task 2 — User model changes
3. Task 3 — Cafe model changes
4. Task 4 — Auth controller updates
5. Task 5 — RBAC middleware
6. Task 6 — Team endpoints
7. Task 7 — Seed script update
8. Task 12 — Migration script
9. Task 8 — Portal types
10. Task 11 — Auth context
11. Task 9 — Cafe switcher
12. Task 10 — Team page

Tasks 1-8 + 12 are backend. Tasks 8-11 are portal. Backend must be done first since the portal depends on the new API shape.
