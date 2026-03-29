const express = require('express');
const router = express.Router();

module.exports = (db) => {
    router.get('/', async (req, res) => {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
            const filter = req.query.type ? { type: req.query.type } : {};
            const logs = await db.collection('logs')
                .find(filter)
                .sort({ createdAt: -1 })
                .limit(limit)
                .toArray();
            res.json(logs);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    return router;
};