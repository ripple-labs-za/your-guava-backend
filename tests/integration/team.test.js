const logger = require('../../src/utils/logger');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const User = require('../../src/models/User.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const Organization = require('../../src/models/Organization.model');
const AuthSession = require('../../src/models/AuthSession.model');
const AccessAuditEvent = require('../../src/models/AccessAuditEvent.model');
const PendingRegistration = require('../../src/models/PendingRegistration.model');
const emailService = require('../../src/services/email.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

describe('Team API', () => {
  let ownerToken;
  let ownerUser;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
    ownerUser = testUser.user;
  });

  describe('POST /api/team/invite', () => {
    it('stores only a hashed pending token, then accepts it exactly once', async () => {
      const cafeId = ownerUser.activeCafeId;
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'New Manager',
          email: 'manager@yourguava.com',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.invitation.email).toBe('manager@yourguava.com');
      expect(res.body.emailSent).toBe(true);
      expect(res.body.token).toBeUndefined();
      expect(inviteSpy).toHaveBeenCalledTimes(1);
      expect(inviteSpy).toHaveBeenCalledWith({
        invitation: expect.objectContaining({
          email: 'manager@yourguava.com',
          name: 'New Manager',
        }),
        owner: expect.objectContaining({ email: 'test@yourguava.com' }),
        cafes: expect.arrayContaining([expect.objectContaining({ name: 'Test Cafe' })]),
        invitationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });

      expect(await User.findOne({ email: 'manager@yourguava.com' })).toBeNull();
      const invitationToken = inviteSpy.mock.calls[0][0].invitationToken;
      const persistedInvite = await TeamInvitation.findById(res.body.invitation.id).select('+tokenHash');
      expect(persistedInvite.status).toBe('pending');
      expect(persistedInvite.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(persistedInvite.tokenHash).not.toBe(invitationToken);
      expect(JSON.stringify(res.body)).not.toContain(invitationToken);

      const preview = await request
        .post('/api/team/invitations/preview')
        .send({ token: invitationToken });
      expect(preview.status).toBe(200);
      expect(preview.headers['cache-control']).toBe('no-store');
      expect(preview.body.invitation).toEqual(expect.objectContaining({
        email: 'manager@yourguava.com',
        organizationName: 'Test Org',
        cafeNames: ['Test Cafe'],
      }));
      expect(JSON.stringify(preview.body)).not.toContain(invitationToken);

      const organizationBeforeAccept = await Organization.findById(ownerUser.orgId).lean();
      const accepted = await request
        .post('/api/team/invitations/accept')
        .send({ token: invitationToken, password: 'chosen-password-123' });
      expect(accepted.status).toBe(201);
      expect(accepted.headers['cache-control']).toBe('no-store');
      expect(accepted.body.user).toEqual({ email: 'manager@yourguava.com' });

      const persisted = await User.findOne({ email: 'manager@yourguava.com' }).select('+password');
      expect(persisted).toBeTruthy();
      expect(persisted.role).toBe('manager');
      expect(persisted.orgId.toString()).toBe(ownerUser.orgId.toString());
      expect(persisted.activeCafeId.toString()).toBe(cafeId.toString());
      await expect(persisted.comparePassword('chosen-password-123')).resolves.toBe(true);
      const organizationAfterAccept = await Organization.findById(ownerUser.orgId).lean();
      expect(organizationAfterAccept.__v).toBeGreaterThan(organizationBeforeAccept.__v);

      const replay = await request
        .post('/api/team/invitations/accept')
        .send({ token: invitationToken, password: 'another-password-123' });
      expect(replay.status).toBe(404);
      expect(replay.headers['cache-control']).toBe('no-store');
      expect(replay.body.message).toMatch(/invalid or has expired/i);
      expect(await User.countDocuments({ email: 'manager@yourguava.com' })).toBe(1);
    });

    it('revokes the pending token and creates no account when invite email is skipped', async () => {
      const cafeId = ownerUser.activeCafeId;
      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ skipped: true, reason: 'resend_not_configured' });
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'No Email Manager',
          email: 'no-email@yourguava.com',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.emailSent).toBe(false);
      expect(res.body.message).toMatch(/email is not configured/i);
      expect(warnSpy).toHaveBeenCalledWith('invitation_email_unconfigured', expect.objectContaining({ invitationId: expect.any(String) }));

      const persisted = await User.findOne({ email: 'no-email@yourguava.com' });
      expect(persisted).toBeNull();
      const invitation = await TeamInvitation.findOne({ email: 'no-email@yourguava.com' });
      expect(invitation.status).toBe('revoked');
      expect(res.body.seats.used).toBe(1);
    });

    it('keeps an existing signup verification usable when invite delivery fails', async () => {
      let verificationToken;
      jest
        .spyOn(emailService, 'sendVerificationEmail')
        .mockImplementation(async ({ verificationToken: token }) => {
          verificationToken = token;
          return { sent: true };
        });
      const pendingSignup = await request
        .post('/api/auth/register')
        .send({
          name: 'Pending Owner',
          email: 'pending-owner@yourguava.com',
          password: 'password123',
          cafeName: 'Pending Cafe',
          orgName: 'Pending Org',
        });
      expect(pendingSignup.status).toBe(202);
      const originalRegistration = await PendingRegistration.findOne({
        email: 'pending-owner@yourguava.com',
      }).lean();

      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ skipped: true, reason: 'resend_not_configured' });
      jest.spyOn(logger, 'warn').mockImplementation(() => {});
      jest.spyOn(emailService, 'sendWelcomeEmail').mockResolvedValue({ sent: true });

      const invite = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Pending Owner',
          email: 'pending-owner@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });

      expect(invite.status).toBe(503);
      expect(await PendingRegistration.findById(originalRegistration._id)).not.toBeNull();
      expect((await TeamInvitation.findOne({
        email: 'pending-owner@yourguava.com',
      })).status).toBe('revoked');

      const verified = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken, password: 'password123' });
      expect(verified.status).toBe(201);
      expect(verified.body.email).toBe('pending-owner@yourguava.com');
    });

    it('keeps an existing signup when the invitation email is delivered', async () => {
      jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({ sent: true });
      const pendingSignup = await request
        .post('/api/auth/register')
        .send({
          name: 'Invited Owner',
          email: 'invited-owner@yourguava.com',
          password: 'password123',
          cafeName: 'Original Cafe',
          orgName: 'Original Org',
        });
      expect(pendingSignup.status).toBe(202);
      expect(await PendingRegistration.countDocuments({
        email: 'invited-owner@yourguava.com',
      })).toBe(1);

      jest.spyOn(emailService, 'sendTeamInviteEmail').mockResolvedValue({ sent: true });
      const invite = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Invited Owner',
          email: 'invited-owner@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });

      expect(invite.status).toBe(201);
      expect(await PendingRegistration.countDocuments({
        email: 'invited-owner@yourguava.com',
      })).toBe(1);
      expect((await TeamInvitation.findOne({
        email: 'invited-owner@yourguava.com',
      })).status).toBe('pending');
    });

    it('manager cannot invite (403)', async () => {
      const cafeId = ownerUser.activeCafeId;

      // Create manager first
      const manager = await createTestManager(ownerToken, [cafeId]);

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${manager.token}`)
        .send({
          name: 'Another Manager',
          email: 'another@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it('blocks invites when plan seat limit is reached', async () => {
      const cafeId = ownerUser.activeCafeId;

      await createTestManager(ownerToken, [cafeId]);

      const res = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Extra Manager',
          email: 'extra@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      expect(res.status).toBe(402);
      expect(res.body.message).toMatch(/seat limit/i);
    });

    it('serializes concurrent invites so the seat limit cannot be exceeded', async () => {
      const cafeId = ownerUser.activeCafeId;
      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });

      const responses = await Promise.all([
        request
          .post('/api/team/invite')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ name: 'Manager A', email: 'manager-a@yourguava.com', cafeIds: [cafeId] }),
        request
          .post('/api/team/invite')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ name: 'Manager B', email: 'manager-b@yourguava.com', cafeIds: [cafeId] }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 402]);
      expect(await User.countDocuments({ orgId: ownerUser.orgId })).toBe(1);
      expect(await TeamInvitation.countDocuments({ orgId: ownerUser.orgId, status: 'pending' })).toBe(1);
    });

    it('serializes concurrent acceptance and creates one manager account', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Concurrent Manager',
          email: 'concurrent@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      const token = inviteSpy.mock.calls[0][0].invitationToken;

      const responses = await Promise.all([
        request.post('/api/team/invitations/accept').send({ token, password: 'chosen-password-123' }),
        request.post('/api/team/invitations/accept').send({ token, password: 'chosen-password-123' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 404]);
      expect(await User.countDocuments({ email: 'concurrent@yourguava.com' })).toBe(1);
    });

    it('revalidates the seat limit at acceptance time', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Delayed Manager',
          email: 'delayed@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      const token = inviteSpy.mock.calls[0][0].invitationToken;
      await User.create({
        name: 'Existing Manager',
        email: 'existing@yourguava.com',
        password: 'password123',
        role: 'manager',
        orgId: ownerUser.orgId,
        cafeIds: [ownerUser.activeCafeId],
        activeCafeId: ownerUser.activeCafeId,
      });

      const accepted = await request
        .post('/api/team/invitations/accept')
        .send({ token, password: 'chosen-password-123' });

      expect(accepted.status).toBe(409);
      expect(accepted.body.message).toMatch(/ask the account owner/i);
      expect(await User.findOne({ email: 'delayed@yourguava.com' })).toBeNull();
      expect((await TeamInvitation.findOne({ email: 'delayed@yourguava.com' })).status).toBe('pending');
    });

    it('rotates tokens on resend and revokes an unused invitation', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      const invited = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Resend Manager',
          email: 'resend@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      const firstToken = inviteSpy.mock.calls[0][0].invitationToken;

      const resent = await request
        .post(`/api/team/invitations/${invited.body.invitation.id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(resent.status).toBe(200);
      const secondToken = inviteSpy.mock.calls[1][0].invitationToken;
      expect(secondToken).not.toBe(firstToken);

      expect((await request.post('/api/team/invitations/preview').send({ token: firstToken })).status).toBe(404);
      expect((await request.post('/api/team/invitations/preview').send({ token: secondToken })).status).toBe(200);

      const revoked = await request
        .delete(`/api/team/invitations/${invited.body.invitation.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body.seats).toEqual(expect.objectContaining({ active: 1, pending: 0, used: 1 }));
      expect((await request.post('/api/team/invitations/preview').send({ token: secondToken })).status).toBe(404);
    });
  });

  describe('GET /api/team', () => {
    it('lists active members separately from pending invitations', async () => {
      const cafeId = ownerUser.activeCafeId;
      jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });

      // Send an invitation without accepting it.
      await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Team Member',
          email: 'team@yourguava.com',
          password: 'password123',
          cafeIds: [cafeId],
        });

      const res = await request
        .get('/api/team')
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.members).toBeDefined();
      expect(res.body.members).toHaveLength(1);
      expect(res.body.invitations).toHaveLength(1);
      expect(res.body.invitations[0].email).toBe('team@yourguava.com');
      expect(res.body.seats).toEqual(expect.objectContaining({ active: 1, pending: 1, used: 2 }));
    });
  });

  describe('POST /api/team/switch-cafe', () => {
    it('switches active cafe and returns new token', async () => {
      // Add a second cafe
      const addRes = await request
        .post('/api/team/add-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Second Cafe' });

      const secondCafeId = addRes.body.cafe._id;

      const res = await request
        .post('/api/team/switch-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ cafeId: secondCafeId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.activeCafeId).toBe(secondCafeId);
    });
  });

  describe('POST /api/team/add-cafe', () => {
    it('adds new cafe to org', async () => {
      const res = await request
        .post('/api/team/add-cafe')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'New Branch' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.cafe).toBeDefined();
      expect(res.body.cafe.name).toBe('New Branch');
    });
  });

  describe('DELETE /api/team/:id', () => {
    it('removes manager from org', async () => {
      const cafeId = ownerUser.activeCafeId;
      const manager = await createTestManager(ownerToken, [cafeId]);
      const managerId = manager.user.id;

      const res = await request
        .delete(`/api/team/${managerId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/removed/i);
    });
  });

  describe('permissions, ownership, and access audit', () => {
    it('carries explicit credit-spend permission from invitation through member updates', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      const invited = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Metered Manager',
          email: 'metered@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
          canSpendCredits: true,
        });
      expect(invited.status).toBe(201);
      expect(invited.body.invitation.permissions).toEqual({ canSpendCredits: true });

      const token = inviteSpy.mock.calls[0][0].invitationToken;
      const preview = await request
        .post('/api/team/invitations/preview')
        .send({ token });
      expect(preview.body.invitation.canSpendCredits).toBe(true);
      await request
        .post('/api/team/invitations/accept')
        .send({ token, password: 'manager-password-123' });

      const manager = await User.findOne({ email: 'metered@yourguava.com' });
      expect(manager.permissions.canSpendCredits).toBe(true);
      const updated = await request
        .patch(`/api/team/${manager._id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Metered Manager',
          cafeIds: [ownerUser.activeCafeId],
          canSpendCredits: false,
        });
      expect(updated.status).toBe(200);
      expect(updated.body.member.permissions).toEqual({ canSpendCredits: false });

      const invalid = await request
        .patch(`/api/team/${manager._id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ canSpendCredits: 'yes' });
      expect(invalid.status).toBe(400);
      expect(await AccessAuditEvent.countDocuments({
        orgId: ownerUser.orgId,
        action: 'member.updated',
        targetUserId: manager._id,
      })).toBe(1);
    });

    it('shows expired invitations and lets the owner resend or revoke them', async () => {
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      const invited = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Expired Manager',
          email: 'expired@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      await TeamInvitation.updateOne(
        { _id: invited.body.invitation.id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } }
      );

      const listed = await request
        .get('/api/team')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(listed.body.invitations).toEqual([
        expect.objectContaining({
          email: 'expired@yourguava.com',
          status: 'expired',
        }),
      ]);
      expect(listed.body.seats.pending).toBe(0);

      const resent = await request
        .post(`/api/team/invitations/${invited.body.invitation.id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(resent.status).toBe(200);
      expect(inviteSpy).toHaveBeenCalledTimes(2);

      const revoked = await request
        .delete(`/api/team/invitations/${invited.body.invitation.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(revoked.status).toBe(200);
    });

    it('transfers the sole owner role atomically and revokes both users sessions', async () => {
      await Organization.updateOne(
        { _id: ownerUser.orgId },
        { $set: { plan: 'growth' } }
      );
      const manager = await createTestManager(ownerToken, [ownerUser.activeCafeId]);
      const inviteSpy = jest
        .spyOn(emailService, 'sendTeamInviteEmail')
        .mockResolvedValue({ sent: true });
      const pendingInvite = await request
        .post('/api/team/invite')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Pending Manager',
          email: 'pending-transfer@yourguava.com',
          cafeIds: [ownerUser.activeCafeId],
        });
      expect(pendingInvite.status).toBe(201);
      const pendingToken = inviteSpy.mock.calls[0][0].invitationToken;

      const transferred = await request
        .post('/api/team/transfer-ownership')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          userId: manager.user.id,
          currentPassword: 'password123',
        });
      expect(transferred.status).toBe(200);

      const [formerOwner, newOwner, org] = await Promise.all([
        User.findById(ownerUser.id).lean(),
        User.findById(manager.user.id).lean(),
        Organization.findById(ownerUser.orgId).lean(),
      ]);
      expect(formerOwner.role).toBe('manager');
      expect(formerOwner.permissions.canSpendCredits).toBe(false);
      expect(newOwner.role).toBe('owner');
      expect(String(org.ownerId)).toBe(String(newOwner._id));
      expect(await User.countDocuments({
        orgId: ownerUser.orgId,
        role: 'owner',
      })).toBe(1);
      expect(await AuthSession.countDocuments({
        userId: { $in: [formerOwner._id, newOwner._id] },
        revokedAt: null,
      })).toBe(0);

      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${ownerToken}`)
        ).status
      ).toBe(401);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${manager.token}`)
        ).status
      ).toBe(401);
      expect(await AccessAuditEvent.countDocuments({
        orgId: ownerUser.orgId,
        action: 'ownership.transferred',
      })).toBe(1);

      const reassignedInvite = await TeamInvitation.findById(
        pendingInvite.body.invitation.id
      ).lean();
      expect(String(reassignedInvite.invitedByUserId)).toBe(String(newOwner._id));
      const previewAfterTransfer = await request
        .post('/api/team/invitations/preview')
        .send({ token: pendingToken });
      expect(previewAfterTransfer.status).toBe(200);
    });

    it('exposes durable access events to owners only', async () => {
      const manager = await createTestManager(ownerToken, [ownerUser.activeCafeId]);
      await request
        .patch(`/api/team/${manager.user.id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Audited Manager',
          cafeIds: [ownerUser.activeCafeId],
          canSpendCredits: true,
        });

      const ownerView = await request
        .get('/api/team/audit-events')
        .set('Authorization', `Bearer ${ownerToken}`);
      const managerView = await request
        .get('/api/team/audit-events')
        .set('Authorization', `Bearer ${manager.token}`);
      expect(ownerView.status).toBe(200);
      expect(ownerView.body.events[0]).toEqual(expect.objectContaining({
        action: 'member.updated',
        targetEmail: 'manager@yourguava.com',
      }));
      expect(managerView.status).toBe(403);
    });
  });
});
