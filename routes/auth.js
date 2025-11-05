const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.get('/login', authController.login);
router.get('/callback', authController.loginCallback);
router.post('/verify', authController.verify);
router.get('/keys', authController.getKeys);
router.post('/keys', authController.createKey);
router.post('/keys/:id/renew', authController.renewKey);
router.delete('/keys/:id', authController.deleteKey);


module.exports = router;
