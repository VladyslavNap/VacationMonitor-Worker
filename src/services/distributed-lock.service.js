import { nanoid } from 'nanoid';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Distributed Lock Service using Cosmos DB
 * Implements leader election for multi-instance scheduler coordination
 */
class DistributedLockService {
  constructor() {
    this.client = null;
    this.database = null;
    this.locksContainer = null;
    this.instanceId = nanoid(12); // Unique ID for this worker instance
    this.lockName = 'scheduler-lock';
    this.lockDurationSeconds = 90; // Lock expires after 90 seconds
    this.lockRenewalIntervalSeconds = 30; // Renew every 30 seconds
    this.currentLock = null;
    this.renewalIntervalId = null;
  }

  /**
   * Initialize the distributed lock service
   */
  async initialize() {
    try {
      const { CosmosClient } = await import('@azure/cosmos');

      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const databaseName = process.env.COSMOS_DATABASE_NAME;

      if (!endpoint || !key || !databaseName) {
        throw new Error('Missing required Cosmos DB environment variables for distributed lock');
      }

      this.client = new CosmosClient({ endpoint, key });
      this.database = this.client.database(databaseName);

      // Create locks container if it doesn't exist
      const { container } = await this.database.containers.createIfNotExists({
        id: 'locks',
        partitionKey: { paths: ['/lockName'] }
      });

      this.locksContainer = container;

      logger.info('Distributed lock service initialized', {
        instanceId: this.instanceId,
        lockName: this.lockName,
        lockDurationSeconds: this.lockDurationSeconds
      });
    } catch (error) {
      logger.error('Failed to initialize distributed lock service', { error: error.message });
      throw error;
    }
  }

  /**
   * Try to acquire the distributed lock
   * @returns {Promise<boolean>} - True if lock acquired, false otherwise
   */
  async acquireLock() {
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.lockDurationSeconds * 1000);

      const lockDoc = {
        id: this.lockName,
        lockName: this.lockName, // Partition key
        instanceId: this.instanceId,
        acquiredAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        renewedAt: now.toISOString()
      };

      try {
        // Try to read existing lock
        const { resource: existingLock } = await this.locksContainer
          .item(this.lockName, this.lockName)
          .read();

        const lockExpiry = new Date(existingLock.expiresAt);
        const isExpired = lockExpiry < now;

        // If lock is held by this instance and not expired, we already have the lock
        if (existingLock.instanceId === this.instanceId && !isExpired) {
          this.currentLock = existingLock;
          return true;
        }

        // If lock is held by another instance and not expired, we can't acquire it
        if (!isExpired) {
          logger.debug('Lock is held by another instance', {
            lockHolder: existingLock.instanceId,
            expiresAt: existingLock.expiresAt,
            currentInstance: this.instanceId
          });
          return false;
        }

        // Lock is expired, try to take it over (optimistic concurrency)
        lockDoc._etag = existingLock._etag; // Include ETag for optimistic concurrency
        const { resource: updatedLock } = await this.locksContainer.items.upsert(lockDoc, {
          accessCondition: { type: 'IfMatch', condition: existingLock._etag }
        });

        this.currentLock = updatedLock;
        this.startRenewalTimer();

        logger.info('✅ Distributed lock acquired (takeover)', {
          instanceId: this.instanceId,
          previousHolder: existingLock.instanceId,
          expiresAt: lockDoc.expiresAt
        });

        return true;
      } catch (error) {
        // Lock doesn't exist yet, try to create it
        if (error.code === 404) {
          try {
            const { resource: newLock } = await this.locksContainer.items.create(lockDoc);
            this.currentLock = newLock;
            this.startRenewalTimer();

            logger.info('✅ Distributed lock acquired (new)', {
              instanceId: this.instanceId,
              expiresAt: lockDoc.expiresAt
            });

            return true;
          } catch (createError) {
            // Another instance created the lock at the same time (race condition)
            if (createError.code === 409) {
              logger.debug('Lock created by another instance during race condition');
              return false;
            }
            throw createError;
          }
        }

        // Precondition failed - another instance updated the lock (race condition)
        if (error.code === 412) {
          logger.debug('Lock updated by another instance during race condition');
          return false;
        }

        throw error;
      }
    } catch (error) {
      logger.error('Error acquiring distributed lock', {
        instanceId: this.instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Renew the current lock to extend its expiration
   */
  async renewLock() {
    if (!this.currentLock) {
      return false;
    }

    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.lockDurationSeconds * 1000);

      const updatedLock = {
        ...this.currentLock,
        expiresAt: expiresAt.toISOString(),
        renewedAt: now.toISOString()
      };

      const { resource } = await this.locksContainer.items.upsert(updatedLock, {
        accessCondition: { type: 'IfMatch', condition: this.currentLock._etag }
      });

      this.currentLock = resource;

      logger.debug('Lock renewed', {
        instanceId: this.instanceId,
        expiresAt: expiresAt.toISOString()
      });

      return true;
    } catch (error) {
      if (error.code === 412) {
        // Another instance took over the lock
        logger.warn('Lock was taken over by another instance', {
          instanceId: this.instanceId
        });
        this.currentLock = null;
        this.stopRenewalTimer();
        return false;
      }

      logger.error('Error renewing lock', {
        instanceId: this.instanceId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Release the current lock
   */
  async releaseLock() {
    if (!this.currentLock) {
      return;
    }

    try {
      this.stopRenewalTimer();

      // Delete the lock document
      await this.locksContainer
        .item(this.lockName, this.lockName)
        .delete({
          accessCondition: { type: 'IfMatch', condition: this.currentLock._etag }
        });

      logger.info('Distributed lock released', { instanceId: this.instanceId });

      this.currentLock = null;
    } catch (error) {
      if (error.code === 404 || error.code === 412) {
        // Lock already released or taken over by another instance
        logger.debug('Lock already released or taken over', { instanceId: this.instanceId });
      } else {
        logger.error('Error releasing lock', {
          instanceId: this.instanceId,
          error: error.message
        });
      }
      this.currentLock = null;
    }
  }

  /**
   * Check if this instance currently holds the lock
   */
  isLockHeld() {
    if (!this.currentLock) {
      return false;
    }

    const now = new Date();
    const expiresAt = new Date(this.currentLock.expiresAt);

    return expiresAt > now;
  }

  /**
   * Start automatic lock renewal timer
   */
  startRenewalTimer() {
    if (this.renewalIntervalId) {
      return; // Already running
    }

    this.renewalIntervalId = setInterval(async () => {
      const renewed = await this.renewLock();
      if (!renewed) {
        this.stopRenewalTimer();
      }
    }, this.lockRenewalIntervalSeconds * 1000);

    logger.debug('Lock renewal timer started', {
      instanceId: this.instanceId,
      intervalSeconds: this.lockRenewalIntervalSeconds
    });
  }

  /**
   * Stop automatic lock renewal timer
   */
  stopRenewalTimer() {
    if (this.renewalIntervalId) {
      clearInterval(this.renewalIntervalId);
      this.renewalIntervalId = null;
      logger.debug('Lock renewal timer stopped', { instanceId: this.instanceId });
    }
  }
}

// Singleton instance
const distributedLockService = new DistributedLockService();

export default distributedLockService;
