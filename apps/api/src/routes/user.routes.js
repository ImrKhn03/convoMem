'use strict';

const { Router } = require('express');
const ctrl = require('../controllers/user.controller');
const { authMiddleware } = require('../middleware/auth');

const router = Router();

router.use(authMiddleware);

router.get('/profile', ctrl.getProfile);
router.patch('/profile', ctrl.updateProfile);
router.post('/change-password', ctrl.changePassword);

module.exports = router;
