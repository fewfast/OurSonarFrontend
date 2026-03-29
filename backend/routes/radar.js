const express = require('express');
const router = express.Router();

module.exports = (db) => {
    router.get('/', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
            const scans = await db.collection('radar_scans')
                .find({})
                .sort({ createdAt: -1 })
                .limit(limit)
                .toArray();
            res.json(scans);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};