const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/login', authController.login);
router.get('/logout', authController.logout);
router.get('/callback', authController.loginCallback);
router.get('/session', authController.requireAuth, authController.getSession);
router.get('/internal/localusers', authController.requireAuth, authController.requireRoles('admin'), authController.getAllLocalUsers);
router.get('/internal/localuser/:cid', authController.requireAuth, authController.requireRoles('admin'), authController.getLocalUser);
router.post('/internal/localuser/:cid/update', express.json(), authController.requireAuth, authController.requireRoles('admin'), authController.updateLocalUser);
router.post('/internal/localuser/:cid/roles', authController.requireAuth, authController.requireRoles('admin'), express.json(), authController.grantRole);
router.delete('/internal/localuser/:cid/roles', authController.requireAuth, authController.requireRoles('admin'), express.json(), authController.revokeRole);

module.exports = router;
