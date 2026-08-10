// FILE: worker/src/db/repositories/AccountRepository.js
// Repository for Account database operations

'use strict';

const { getPrisma } = require('../prisma');

class AccountRepository {
  /**
   * Upsert an account (create if not exists, update if exists)
   * @param {string} accountId - Account ID
   * @param {string} displayName - Display name
   * @returns {Promise<Object>} Account object
   */
  async upsertAccount(accountId, displayName, fields = {}) {
    const prisma = getPrisma();
    
    return await prisma.account.upsert({
      where: { id: accountId },
      update: { 
        displayName,
        ...fields,
        updatedAt: new Date(),
      },
      create: {
        id: accountId,
        displayName,
        ...fields,
      },
    });
  }

  /**
   * Get all accounts
   * @returns {Promise<Array>} Array of accounts
   */
  async getAllAccounts() {
    const prisma = getPrisma();
    
    return await prisma.account.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Get account by ID
   * @param {string} accountId - Account ID
   * @returns {Promise<Object|null>} Account object or null
   */
  async getAccountById(accountId) {
    const prisma = getPrisma();
    
    return await prisma.account.findUnique({
      where: { id: accountId },
    });
  }

  async findCaseInsensitive(accountId) {
    const prisma = getPrisma();
    const raw = String(accountId || '').trim();
    if (!raw) return null;

    const exact = await prisma.account.findUnique({
      where: { id: raw },
    });
    if (exact) return exact;

    const lowered = raw.toLowerCase();
    const candidates = await prisma.account.findMany({
      select: { id: true, displayName: true, sessionStatus: true },
    });

    return candidates.find((account) => String(account.id || '').trim().toLowerCase() === lowered) || null;
  }

  /**
   * Update account's last synced timestamp
   * @param {string} accountId - Account ID
   * @param {Date} timestamp - Last synced timestamp
   * @returns {Promise<Object>} Updated account
   */
  async updateLastSyncedAt(accountId, timestamp = new Date()) {
    const prisma = getPrisma();
    
    return await prisma.account.update({
      where: { id: accountId },
      data: { lastSyncedAt: timestamp },
    });
  }

  async updateSessionState(accountId, fields = {}) {
    const prisma = getPrisma();
    return prisma.account.update({
      where: { id: accountId },
      data: {
        ...fields,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Delete an account and all related data (cascades to conversations and messages)
   * @param {string} accountId - Account ID
   * @returns {Promise<Object>} Deleted account
   */
  async deleteAccount(accountId) {
    const prisma = getPrisma();
    
    return await prisma.account.delete({
      where: { id: accountId },
    });
  }
}

module.exports = new AccountRepository();
