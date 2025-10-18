const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Used at first connection to check if station online & authenticate client
router.get('/login', authController.login);
router.get('/logout', authController.logout);

module.exports = router;