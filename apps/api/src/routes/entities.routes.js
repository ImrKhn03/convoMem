'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/entities.controller');
const { authMiddleware } = require('../middleware/auth');
const { defaultRateLimiter } = require('../middleware/rateLimiter');

const router = Router();

router.use(authMiddleware);
router.use(defaultRateLimiter);

// Mount /search BEFORE /:id to avoid param catching
router.get('/search', ctrl.search);
router.get('/:id', ctrl.getOne);
router.get('/', ctrl.list);
router.delete('/:id', ctrl.remove);

module.exports = router;
