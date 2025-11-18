const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const apiKeyController = require('../controllers/APIkeyController');

router.get('/', authController.requireAuth, authController.requireRoles('admin'), apiKeyController.getKeys);
router.get('/:id', authController.requireAuth, apiKeyController.getUserKey);
router.post('/:id', authController.requireAuth, apiKeyController.createKey);
router.post('/:id/renew', authController.requireAuth, apiKeyController.renewKey);
router.delete('/:id', authController.requireAuth, apiKeyController.deleteKey);
// router.post('/verify', authController.verify); //verify key middleware

module.exports = router;