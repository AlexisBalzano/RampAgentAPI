const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/login', authController.login);
router.get('/logout', authController.logout);
router.get('/callback', authController.loginCallback);
router.get('/session', authController.requireAuth, authController.getSession);
router.get('/internal/localusers', authController.requireAuth, authController.requireRoles('admin'), authController.getAllLocalUsers);
router.get('/internal/localuser/:cid', authController.getLocalUser);
router.post('/internal/localuser/:cid/update', express.json(), authController.updateLocalUser);
router.post('/internal/localuser/:cid/roles', authController.requireAuth, authController.requireRoles('admin'), express.json(), authController.grantRole);
router.delete('/internal/localuser/:cid/roles', authController.requireAuth, authController.requireRoles('admin'), express.json(), authController.revokeRole);
// router.post('/verify', authController.verify);
router.get('/keys', authController.getKeys);
router.get('/keys/:id', authController.getUserKey);
router.post('/key/:id', authController.createKey);
router.post('/keys/:id/renew', authController.renewKey);
router.delete('/keys/:id', authController.deleteKey);


module.exports = router;
