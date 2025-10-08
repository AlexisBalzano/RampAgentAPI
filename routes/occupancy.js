const express = require('express');
const router = express.Router();
const occupancyController = require('../controllers/occupancyController');

router.get('/occupied', occupancyController.getOccupied);

module.exports = router;
