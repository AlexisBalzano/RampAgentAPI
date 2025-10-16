const express = require('express');
const router = express.Router();
const occupancyController = require('../controllers/occupancyController');

router.get('/occupied', occupancyController.getOccupied);
router.get('/blocked', occupancyController.getBlocked);

module.exports = router;
