import os
import json
import random
import server
from aiohttp import web

# --- File Paths ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CHAR_FILE = os.path.join(BASE_DIR, "characters.json")
POSE_FILE = os.path.join(BASE_DIR, "poses.json")
WILDCARD_FILE = os.path.join(BASE_DIR, "wildcards.json")
CLOTHES_FILE = os.path.join(BASE_DIR, "clothes.json") # NEW FILE

# --- Helper Functions ---
def load_data(filepath, default_data):
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading {filepath}: {e}")
    return default_data

def save_data(filepath, data):
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
        return True
    except Exception as e:
        print(f"Error saving {filepath}: {e}")
        return False

def process_wildcards(text):
    wildcards = load_data(WILDCARD_FILE, {})
    for _ in range(5): 
        start_idx = text.find("{")
        end_idx = text.find("}")
        if start_idx == -1 or end_idx == -1:
            break
        wildcard_name = text[start_idx+1:end_idx]
        if wildcard_name in wildcards and wildcards[wildcard_name]:
            replacement = random.choice(wildcards[wildcard_name])
            text = text[:start_idx] + replacement + text[end_idx+1:]
        else:
            text = text[:start_idx] + wildcard_name + text[end_idx+1:]
    return text

# --- API Routes ---
@server.PromptServer.instance.routes.get("/vault_manager")
async def serve_manager(request):
    html_file = os.path.join(BASE_DIR, "manager.html")
    if os.path.exists(html_file):
        return web.FileResponse(html_file)
    return web.Response(status=404, text="manager.html not found.")

@server.PromptServer.instance.routes.get("/vault_api/get")
async def api_get_data(request):
    vault_type = request.query.get("type", "char")
    if vault_type == "char":
        data = load_data(CHAR_FILE, {})
    elif vault_type == "pose":
        data = load_data(POSE_FILE, {})
    elif vault_type == "wildcard":
        data = load_data(WILDCARD_FILE, {})
    elif vault_type == "clothes": # NEW ROUTE
        data = load_data(CLOTHES_FILE, {})
    else:
        data = {}
    return web.json_response(data)

@server.PromptServer.instance.routes.post("/vault_api/save")
async def api_save_data(request):
    post_data = await request.json()
    vault_type = post_data.get("type")
    data = post_data.get("data")

    if vault_type == "char":
        save_data(CHAR_FILE, data)
    elif vault_type == "pose":
        save_data(POSE_FILE, data)
    elif vault_type == "wildcard":
        save_data(WILDCARD_FILE, data)
    elif vault_type == "clothes": # NEW ROUTE
        save_data(CLOTHES_FILE, data)

    return web.json_response({"status": "ok"})

# --- Node 1: Character Vault ---
class CharacterVault:
    @classmethod
    def INPUT_TYPES(cls):
        chars = load_data(CHAR_FILE, {"Default": ""})
        return {"required": {"character": (list(chars.keys()) if chars else ["None"],)}}
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "Prompt Vaults"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def process(self, character):
        chars = load_data(CHAR_FILE, {})
        text = chars.get(character, "")
        return (process_wildcards(text),)

# --- Node 2: Pose Vault ---
class PoseVault:
    def __init__(self):
        self.sequence_index = {}
        self.history = {}

    @classmethod
    def INPUT_TYPES(cls):
        poses = load_data(POSE_FILE, {"Default": [""]})
        return {
            "required": {
                "category": (list(poses.keys()) if poses else ["None"],),
                "mode": (["Random", "Sequential"],),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "Prompt Vaults"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")

    def process(self, category, mode):
        poses = load_data(POSE_FILE, {})
        prompts = poses.get(category, [""])
        if not prompts or prompts == [""]: return ("",)

        total_prompts = len(prompts)

        if mode == "Random":
            if category not in self.history: self.history[category] = []
            history = self.history[category]
            max_memory = max(0, min(5, total_prompts - 1))
            
            while len(history) > max_memory: history.pop(0)
            available = [i for i in range(total_prompts) if i not in history]
            if not available: available = [0]
                
            chosen = random.choice(available)
            history.append(chosen)
            return (process_wildcards(prompts[chosen]),)
        else:
            if category not in self.sequence_index: self.sequence_index[category] = 0
            idx = self.sequence_index[category] % total_prompts
            self.sequence_index[category] += 1
            return (process_wildcards(prompts[idx]),)

# --- Node 3: Clothes Vault (NEW) ---
class ClothesVault:
    @classmethod
    def INPUT_TYPES(cls):
        clothes = load_data(CLOTHES_FILE, {"Default": ""})
        return {
            "required": {
                "style": (list(clothes.keys()) if clothes else ["None"],),
                "mode": (["Selected", "Random"],),
            }
        }
    
    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "Prompt Vaults"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN") # Always run so Random mode updates

    def process(self, style, mode):
        clothes = load_data(CLOTHES_FILE, {})
        if not clothes:
            return ("",)

        if mode == "Random":
            # Pick a completely random style from the dictionary
            random_style = random.choice(list(clothes.keys()))
            text = clothes.get(random_style, "")
        else:
            # Output the specifically selected style
            text = clothes.get(style, "")
            
        final_text = process_wildcards(text)
        return (final_text,)

# --- Node Registration ---
NODE_CLASS_MAPPINGS = {
    "CharacterVault": CharacterVault,
    "PoseVault": PoseVault,
    "ClothesVault": ClothesVault # NEW
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "CharacterVault": "🗃️ Character Vault",
    "PoseVault": "🤸 Pose Vault",
    "ClothesVault": "👗 Clothes Vault" # NEW
}