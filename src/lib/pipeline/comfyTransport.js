// Wraps ComfyUI websocket subscription + re-upload helpers for the Director.
// Factory returns `{ queueWorkflow, reuploadImage, reuploadVideo }`.
//
// `queueWorkflow` resolves to one of:
//   { type: 'video', data }    — a saved video/gif surfaced via WebSocket
//   { type: 'image', data }    — a saved image
//   { type: 'complete' }       — workflow finished but no standard output
//                                 (e.g. SaveVideoChunk wrote directly to disk)
// It rejects with an Error if ComfyUI reports one.

import * as comfy from '../comfyui';

export function createComfyTransport({ wsRef, setPipelineStatus, addLog }) {
  const queueWorkflow = (wf, label) => new Promise(async (resolve, reject) => {
    let resolved = false;
    if (wsRef.current) wsRef.current.close();

    wsRef.current = comfy.connectWebSocket({
      onProgress: ({ value, max }) => {
        setPipelineStatus?.(`${label}: ${max > 0 ? Math.round((value / max) * 100) : 0}%`);
      },
      onExecuted: (nid, o) => {
        if (resolved) return;
        if (o.gifs?.[0]) { resolved = true; resolve({ type: 'video', data: o.gifs[0] }); return; }
        if (o.videos?.[0]) { resolved = true; resolve({ type: 'video', data: o.videos[0] }); return; }
        if (o.images?.length) {
          const vidFile = o.images.find(f => f.filename?.match(/\.(mp4|webm|mov|avi|gif)$/i));
          if (vidFile) { resolved = true; resolve({ type: 'video', data: vidFile }); return; }
          resolved = true; resolve({ type: 'image', data: o.images[0] }); return;
        }
      },
      onComplete: () => {
        // Workflow finished with no standard output node (e.g. SaveVideoChunk wrote to disk).
        // Pipeline caller will check the project folder.
        if (!resolved) { resolved = true; resolve({ type: 'complete' }); }
      },
      onError: (err) => { if (!resolved) { resolved = true; reject(new Error(err)); } },
    });

    try {
      const r = await comfy.queuePrompt(wf);
      addLog?.('director', `Queued ${label}: ${r.prompt_id}`);
    } catch (err) {
      if (!resolved) { resolved = true; reject(err); }
    }
  });

  // Download an output image and re-upload it to ComfyUI input/ so the next
  // workflow can reference it by name. Returns { name, url }.
  const reuploadImage = async (data) => {
    const url = comfy.getImageUrl(data.filename, data.subfolder || '', data.type || 'output');
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Fetch ${resp.status}`);
      const blob = await resp.blob();
      const uploaded = await comfy.uploadImage(new File([blob], data.filename, { type: 'image/png' }));
      addLog?.('director', `Image re-uploaded: ${uploaded.name}`);
      return { name: uploaded.name, url };
    } catch (err) {
      addLog?.('director', `Image re-upload failed: ${err.message}`);
      return { name: data.filename, url };
    }
  };

  // Same, for videos.
  const reuploadVideo = async (data) => {
    const url = comfy.getVideoUrl(data.filename, data.subfolder || 'video', data.type || 'output');
    setPipelineStatus?.('Uploading video to input...');
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Fetch ${resp.status}`);
      const blob = await resp.blob();
      const uploaded = await comfy.uploadVideo(new File([blob], data.filename, { type: 'video/mp4' }));
      addLog?.('director', `Video re-uploaded: ${uploaded.name}`);
      return { name: uploaded.name, url };
    } catch (err) {
      addLog?.('director', `Video re-upload failed: ${err.message}`);
      return { name: data.filename, url };
    }
  };

  return { queueWorkflow, reuploadImage, reuploadVideo };
}
