'use strict';

const { Router } = require('express');
const { getSelectors } = require('../controllers/extension.controller');

const router = Router();

// Public — no auth needed, selectors are not sensitive
router.get('/selectors', getSelectors);

module.exports = router;
