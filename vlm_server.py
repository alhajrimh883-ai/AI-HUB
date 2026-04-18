"""
VLM Server — Local vision model inference via llama-cpp-python.
"""
import sys, os, gc, base64, argparse

# Force unbuffered output so logs appear in Electron console
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

from flask import Flask, request, jsonify

app = Flask(__name__)

# ── State ──
model = None
model_path = None
mmproj_path = None
current_ctx = 4096
current_gpu_layers = -1
current_image_tokens = 1024
chat_handler_name = 'unknown'
state = 'unloaded'


def _unload():
    global model, state
    if model is not None:
        del model
        model = None
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
    state = 'unloaded'


def _discover_handlers():
    """List all available chat handlers at startup."""
    available = []
    try:
        import llama_cpp.llama_chat_format as cf
        for name in dir(cf):
            if 'ChatHandler' in name and not name.startswith('_'):
                available.append(name)
    except Exception as e:
        print(f'[VLM] Error scanning handlers: {e}', flush=True)
    return available


def _get_chat_handler():
    """Auto-detect the best chat handler based on model filename and available handlers."""
    global chat_handler_name
    import llama_cpp.llama_chat_format as cf

    model_lower = (model_path or '').lower()

    # Map model name patterns to preferred handler order
    handler_priority = []
    if 'gemma-4' in model_lower or 'gemma4' in model_lower:
        handler_priority = ['Gemma4ChatHandler', 'Gemma3ChatHandler']
    elif 'gemma' in model_lower:
        handler_priority = ['Gemma3ChatHandler', 'Gemma4ChatHandler']
    elif 'qwen3' in model_lower or 'qwen-3' in model_lower:
        handler_priority = ['Qwen3VLChatHandler', 'Qwen35ChatHandler', 'Qwen25VLChatHandler']
    elif 'qwen2.5' in model_lower or 'qwen25' in model_lower or 'qwen-2.5' in model_lower:
        handler_priority = ['Qwen25VLChatHandler', 'Qwen3VLChatHandler']
    elif 'qwen' in model_lower:
        handler_priority = ['Qwen3VLChatHandler', 'Qwen25VLChatHandler', 'Qwen2VLChatHandler']
    elif 'minicpm' in model_lower:
        handler_priority = ['MiniCPMv45ChatHandler', 'MiniCPMv26ChatHandler']
    elif 'llava' in model_lower:
        handler_priority = ['Llava16ChatHandler', 'Llava15ChatHandler']
    elif 'moondream' in model_lower:
        handler_priority = ['MoondreamChatHandler']
    elif 'lfm' in model_lower:
        handler_priority = ['LFM25VLChatHandler', 'LFM2VLChatHandler']

    # Fallback: try all known VL handlers
    fallback_handlers = [
        'Gemma4ChatHandler', 'Qwen3VLChatHandler', 'Qwen25VLChatHandler',
        'Gemma3ChatHandler', 'MiniCPMv45ChatHandler', 'MiniCPMv26ChatHandler',
        'Llava16ChatHandler', 'MoondreamChatHandler', 'Llava15ChatHandler',
        'LFM25VLChatHandler', 'LFM2VLChatHandler',
    ]

    # Combine: model-specific first, then fallbacks (dedup)
    seen = set()
    ordered = []
    for name in handler_priority + fallback_handlers:
        if name not in seen:
            seen.add(name)
            ordered.append(name)

    for name in ordered:
        cls = getattr(cf, name, None)
        if cls is not None:
            try:
                handler = cls(clip_model_path=mmproj_path, verbose=False)
                chat_handler_name = name
                print(f'[VLM] Using handler: {name}', flush=True)
                return handler
            except Exception as e:
                print(f'[VLM] Handler {name} failed: {e}', flush=True)

    # Last resort: Llava16
    chat_handler_name = 'Llava16ChatHandler (forced)'
    print(f'[VLM] Falling back to Llava16ChatHandler', flush=True)
    return cf.Llava16ChatHandler(clip_model_path=mmproj_path, verbose=False)


def _load(gpu_layers=-1):
    global model, state, current_gpu_layers
    from llama_cpp import Llama

    _unload()

    handler = _get_chat_handler()
    print(f'[VLM] Creating Llama: ctx={current_ctx}, gpu_layers={gpu_layers}', flush=True)
    model = Llama(
        model_path=model_path,
        chat_handler=handler,
        n_ctx=current_ctx,
        n_gpu_layers=gpu_layers,
        verbose=False,
    )
    current_gpu_layers = gpu_layers
    state = 'loaded' if gpu_layers != 0 else 'parked'
    print(f'[VLM] Model loaded. State={state}', flush=True)


@app.route('/load', methods=['POST'])
def load_model():
    global model_path, mmproj_path, current_ctx, current_image_tokens
    try:
        data = request.json or {}
        model_path = data.get('model_path', model_path)
        mmproj_path = data.get('mmproj_path', mmproj_path)
        current_ctx = data.get('ctx', current_ctx) or 4096
        current_image_tokens = data.get('image_tokens', current_image_tokens) or 1024
        gpu_layers = data.get('gpu_layers', -1)

        if not model_path or not mmproj_path:
            return jsonify({'error': 'model_path and mmproj_path required'}), 400

        print(f'[VLM] /load: model={os.path.basename(model_path)}, ctx={current_ctx}, tokens={current_image_tokens}', flush=True)
        _load(gpu_layers)
        return jsonify({'status': 'ok', 'state': state, 'handler': chat_handler_name})
    except Exception as e:
        import traceback; traceback.print_exc()
        _unload()
        return jsonify({'error': str(e)}), 500


@app.route('/infer', methods=['POST'])
def infer():
    global model, state
    if model is None:
        return jsonify({'error': 'No model loaded'}), 400

    if state == 'parked':
        print('[VLM] Re-layering from RAM to GPU...', flush=True)
        _load(gpu_layers=-1)

    try:
        data = request.json or {}
        image_b64 = data.get('image_base64', '')
        images_b64 = data.get('images_base64', [])  # multi-image support
        user_prompt = data.get('user_prompt', 'Describe this image in detail.')
        system_prompt = data.get('system_prompt', '')
        max_tokens = data.get('max_tokens', 2048)

        num_images = len(images_b64) if images_b64 else (1 if image_b64 else 0)
        print(f'[VLM] /infer: images={num_images}, prompt_len={len(user_prompt)}, max_tokens={max_tokens}', flush=True)
        if user_prompt:
            print(f'[VLM] Prompt preview: {user_prompt[:150]}...', flush=True)

        # Build messages
        messages = []
        if system_prompt:
            messages.append({'role': 'system', 'content': system_prompt})

        # User message with image(s)
        content = []
        if images_b64:
            # Multiple images (video frames)
            for i, img in enumerate(images_b64):
                content.append({
                    'type': 'image_url',
                    'image_url': {'url': f'data:image/jpeg;base64,{img}'}
                })
            print(f'[VLM] Sending {len(images_b64)} images to model', flush=True)
        elif image_b64:
            # Single image
            content.append({
                'type': 'image_url',
                'image_url': {'url': f'data:image/jpeg;base64,{image_b64}'}
            })
        content.append({'type': 'text', 'text': user_prompt})
        messages.append({'role': 'user', 'content': content})

        print(f'[VLM] Calling create_chat_completion... (handler: {chat_handler_name})', flush=True)
        result = model.create_chat_completion(messages=messages, max_tokens=max_tokens)

        # Extract and log result
        choices = result.get('choices', [])
        if choices:
            text = choices[0].get('message', {}).get('content', '')
            finish = choices[0].get('finish_reason', 'unknown')
            usage = result.get('usage', {})
            print(f'[VLM] Response: {len(text)} chars, finish={finish}, tokens={usage}', flush=True)
            if text:
                print(f'[VLM] Output preview: {text[:200]}', flush=True)
            else:
                print(f'[VLM] WARNING: Empty response!', flush=True)
                print(f'[VLM] Full result dump: {result}', flush=True)
        else:
            text = ''
            print(f'[VLM] WARNING: No choices in result!', flush=True)
            print(f'[VLM] Full result dump: {result}', flush=True)

        return jsonify({'text': text.strip(), 'status': 'ok', 'handler': chat_handler_name})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/chat-infer', methods=['POST'])
def chat_infer():
    """Chat-style inference with full message history.
    Accepts: { messages: [{role, content}], max_tokens }
    Content can be string or array of {type:'text'|'image_url', ...}
    """
    global model, state
    if model is None:
        return jsonify({'error': 'No model loaded'}), 400

    if state == 'parked':
        print('[VLM] Re-layering from RAM to GPU...', flush=True)
        _load(gpu_layers=-1)

    try:
        data = request.json or {}
        messages = data.get('messages', [])
        max_tokens = data.get('max_tokens', 2048)

        # Count images and text in all messages
        total_images = 0
        total_text_len = 0
        for msg in messages:
            c = msg.get('content', '')
            if isinstance(c, str):
                total_text_len += len(c)
            elif isinstance(c, list):
                for part in c:
                    if part.get('type') == 'text':
                        total_text_len += len(part.get('text', ''))
                    elif part.get('type') == 'image_url':
                        total_images += 1

        print(f'[VLM] /chat-infer: turns={len(messages)}, images={total_images}, text_len={total_text_len}, max_tokens={max_tokens}', flush=True)

        result = model.create_chat_completion(messages=messages, max_tokens=max_tokens)

        choices = result.get('choices', [])
        if choices:
            text = choices[0].get('message', {}).get('content', '')
            usage = result.get('usage', {})
            print(f'[VLM] Chat response: {len(text)} chars, tokens={usage}', flush=True)
        else:
            text = ''
            print(f'[VLM] WARNING: No choices! {result}', flush=True)

        return jsonify({'text': text.strip(), 'status': 'ok', 'usage': result.get('usage', {})})
    except Exception as e:
        import traceback; traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/park', methods=['POST'])
def park():
    global state
    if model is None and model_path:
        _load(gpu_layers=0)
    elif state == 'loaded':
        _load(gpu_layers=0)
    return jsonify({'status': 'ok', 'state': state})


@app.route('/unload', methods=['POST'])
def unload():
    _unload()
    return jsonify({'status': 'ok', 'state': state})


@app.route('/status', methods=['GET'])
def status():
    return jsonify({
        'state': state,
        'model': os.path.basename(model_path) if model_path else None,
        'gpu_layers': current_gpu_layers,
        'ctx': current_ctx,
        'image_tokens': current_image_tokens,
        'handler': chat_handler_name,
    })


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5123)
    args = parser.parse_args()

    # Startup diagnostics
    print(f'[VLM] Server starting on port {args.port}', flush=True)
    print(f'[VLM] Python: {sys.version}', flush=True)

    handlers = _discover_handlers()
    print(f'[VLM] Available handlers: {", ".join(handlers)}', flush=True)

    try:
        import llama_cpp
        print(f'[VLM] llama-cpp-python version: {llama_cpp.__version__}', flush=True)
    except:
        print('[VLM] Could not detect llama-cpp-python version', flush=True)

    app.run(host='127.0.0.1', port=args.port, threaded=False)
