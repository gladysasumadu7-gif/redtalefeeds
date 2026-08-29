const express = require('express');
const { handleChatMessage } = require('../services/geminiService');
const { supabase } = require('../lib/supabase');

const router = express.Router();

// Looks up (or lazily creates) the Supabase thread row for this user's
// client-generated thread id. Threads are private to the user who owns
// them — every query below filters on user_id, so one user can never read
// or write into another user's thread even if they guess the id.
async function getOrCreateThread(userId, clientThreadId) {
  const { data: existing, error: findError } = await supabase
    .from('chat_threads')
    .select('id, client_thread_id')
    .eq('user_id', userId)
    .eq('client_thread_id', clientThreadId)
    .maybeSingle();

  if (findError) throw findError;
  if (existing) return existing;

  const { data: created, error: createError } = await supabase
    .from('chat_threads')
    .insert({ user_id: userId, client_thread_id: clientThreadId })
    .select('id, client_thread_id')
    .single();

  if (createError) throw createError;
  return created;
}

router.get('/threads', async (req, res) => {
  const { data, error } = await supabase
    .from('chat_threads')
    .select('client_thread_id, title, last_message_preview, updated_at')
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[chat route] list threads error:', error);
    return res.status(500).json({ error: 'Failed to load threads' });
  }

  res.json({
    threads: data.map((t) => ({
      id: t.client_thread_id,
      title: t.title,
      lastMessagePreview: t.last_message_preview,
      updatedAt: t.updated_at,
    })),
  });
});

router.get('/threads/:id/messages', async (req, res) => {
  try {
    const thread = await getOrCreateThread(req.user.id, req.params.id);
    const { data, error } = await supabase
      .from('chat_messages')
      .select('id, role, content, offers, search_query, created_at')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json({
      messages: data.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        offers: m.offers,
        searchQuery: m.search_query,
        createdAt: m.created_at,
      })),
    });
  } catch (err) {
    console.error('[chat route] get messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /chat/threads/:id/messages  { message: string }
router.post('/threads/:id/messages', async (req, res) => {
  const { message } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message (non-empty string) is required' });
  }

  try {
    const thread = await getOrCreateThread(req.user.id, req.params.id);

    const { error: insertUserErr } = await supabase
      .from('chat_messages')
      .insert({ thread_id: thread.id, role: 'user', content: message.trim() });
    if (insertUserErr) throw insertUserErr;

    // Only the last few turns are needed for intent classification context.
    const { data: recentMessages, error: historyErr } = await supabase
      .from('chat_messages')
      .select('role, content')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (historyErr) throw historyErr;

    const history = recentMessages
      .reverse()
      .slice(0, -1) // drop the user message we just inserted, handleChatMessage takes it separately
      .map((m) => ({ role: m.role, content: m.content }));

    const { reply, offers, query } = await handleChatMessage(message.trim(), history);

    const { data: assistantRow, error: insertAssistantErr } = await supabase
      .from('chat_messages')
      .insert({
        thread_id: thread.id,
        role: 'assistant',
        content: reply,
        offers: offers || null,
        search_query: query || null,
      })
      .select('id, role, content, offers, search_query, created_at')
      .single();
    if (insertAssistantErr) throw insertAssistantErr;

    await supabase
      .from('chat_threads')
      .update({
        last_message_preview: reply.slice(0, 140),
        updated_at: new Date().toISOString(),
      })
      .eq('id', thread.id);

    res.json({
      message: {
        id: assistantRow.id,
        role: assistantRow.role,
        content: assistantRow.content,
        offers: assistantRow.offers,
        searchQuery: assistantRow.search_query,
        createdAt: assistantRow.created_at,
      },
      thread: req.params.id,
    });
  } catch (err) {
    console.error('[chat route] error:', err);
    res.status(502).json({ error: 'Failed to process chat message' });
  }
});

module.exports = router;