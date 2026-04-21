import time
import threading
from aiohttp import web

# One global gate state (simple version).
# If you need per-node-instance gates, tell me and I'll make it keyed by unique node id.
_gate_event = threading.Event()
_gate_event.set()  # start "open" by default

def _set_gate(open_: bool):
    if open_:
        _gate_event.set()
    else:
        _gate_event.clear()

class ManualGateAny:
    """
    Accept anything, output the same thing, but can block execution until "Resume".
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "value": ("*",),                  # accepts any
                "start_closed": ("BOOLEAN", {"default": True}),
                "poll_ms": ("INT", {"default": 50, "min": 1, "max": 1000}),
            }
        }

    RETURN_TYPES = ("*",)                         # returns any
    FUNCTION = "gate"
    CATEGORY = "utils"

    def gate(self, value, start_closed=True, poll_ms=50):
        # If start_closed, close the gate as we enter this node.
        if start_closed:
            _set_gate(False)

        # Block until resumed (or until the process is interrupted).
        while not _gate_event.is_set():
            time.sleep(poll_ms / 1000.0)

        return (value,)


# ---- HTTP API for the UI buttons ----

async def gate_open(request):
    _set_gate(True)
    return web.json_response({"ok": True, "gate": "open"})

async def gate_close(request):
    _set_gate(False)
    return web.json_response({"ok": True, "gate": "closed"})

def add_routes(app: web.Application):
    app.router.add_post("/manual_gate/open", gate_open)
    app.router.add_post("/manual_gate/close", gate_close)


NODE_CLASS_MAPPINGS = {
    "ManualGateAny": ManualGateAny,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ManualGateAny": "Manual Gate (Any) - Resume/Stop",
}

# ComfyUI will call this if present in many installs; if yours doesn't, tell me your ComfyUI version.
WEB_DIRECTORY = None

def init_app(app):
    add_routes(app)