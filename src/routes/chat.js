const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { handleChatMessage } = require('../services/geminiService');

const router = express.Router();

// In-memory thread store — swap for Postgres/Prisma later, shape is already
// close to the ShopBot backend's ChatMessage contract.
const threads = new Map(); // threadId -> [{id, role, content, offers, createdAt}]

router.get('/threads', (req, res) => {
  res.json({
    threads: [...threads.keys()].map((id) => ({ id, messageCount: threads.get(id).length })),
  });
});

router.get('/threads/:id/messages', (req, res) => {
  const messages = threads.get(req.params.id) || [];
  res.json({ messages });
});

// POST /chat/threads/:id/messages  { message: string }
router.post('/threads/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { message } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message (non-empty string) is required' });
  }

  if (!threads.has(id)) threads.set(id, []);
  const thread = threads.get(id);

  const userMessage = { id: uuidv4(), role: 'user', content: message.trim(), offers: null, createdAt: new Date().toISOString() };
  thread.push(userMessage);

  try {
    const history = thread.slice(-10, -1).map((m) => ({ role: m.role, content: m.content }));
    const { reply, offers, query } = await handleChatMessage(message.trim(), history);

    const assistantMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: reply,
      offers: offers || null,
      searchQuery: query || null,
      createdAt: new Date().toISOString(),
    };
    thread.push(assistantMessage);

    res.json({ message: assistantMessage, thread: id });
  } catch (err) {
    console.error('[chat route] error:', err);
    res.status(500).json({ error: 'Failed to process chat message' });
  }
});

module.exports = router;
