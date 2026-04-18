// Chat-history + token-budget helper for the Director VLM conversation.
// Factory returns `{ messages, buildImageContent, stripOldImages, calcTokens, trim }`.
//
// `messages` is the raw array so callers can still push/splice — this keeps
// the extraction surgical. The interesting logic (image stripping, token
// budgeting, oldest-pair eviction) is encapsulated in the returned helpers.

export function createChatContext({
  ctxLimit = 16384,
  imgTokens = 1024,
  addLog,
  onStatus,
} = {}) {
  const messages = [];
  const estimateTokens = (text) => Math.round((text?.length || 0) / 3.5);

  // Build VLM content array: [image, image, ..., text] from base64 frames + prompt.
  const buildImageContent = (frames, text) => {
    const content = [];
    for (const img of frames) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } });
    }
    content.push({ type: 'text', text });
    return content;
  };

  // Strip images from ALL previous user messages, replace with a text note.
  // Keeps the conversational flow but drops the image tokens so they don't blow the context.
  const stripOldImages = () => {
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const imageCount = msg.content.filter(p => p.type === 'image_url').length;
        if (imageCount > 0) {
          const textParts = msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
          msg.content = `[${imageCount} frames were shown]\n${textParts}`;
          msg._strippedImages = imageCount;
        }
      }
    }
  };

  // Estimated total tokens in chat history, plus N new image tokens we're about to add.
  const calcTokens = (extraFrames = 0) => {
    let total = extraFrames * imgTokens;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'text') total += estimateTokens(p.text);
          else if (p.type === 'image_url') total += imgTokens;
        }
      }
    }
    return total;
  };

  // Trim oldest user+assistant pair until we're under budget (with a hard cap on attempts).
  const trim = (newFrameCount) => {
    const responseBuffer = 1500; // space for VLM response + template
    const budget = ctxLimit - responseBuffer;
    let attempts = 0;
    while (calcTokens(newFrameCount) > budget && messages.length >= 2 && attempts < 20) {
      const removed = messages.splice(0, 2);
      addLog?.('director', `Chat trimmed oldest pair (${removed[0]?.content?.substring?.(0, 40) || '[images]'}...)`);
      attempts++;
    }
    if (attempts > 0) {
      onStatus?.(`Trimmed ${attempts} old exchanges from context`);
    }
    return attempts;
  };

  return { messages, buildImageContent, stripOldImages, calcTokens, trim };
}
