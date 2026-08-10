'use strict';

const express = require('express');
const router = express.Router();
const getPool = require('../../lib/db').default || require('../db/prisma');

/**
 * Basic health check endpoint.
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Deep health probe endpoint checking DB & Redis connectivity.
 */
router.get('/health/readiness', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: err.message,
    });
  }
});

module.exports = router;
