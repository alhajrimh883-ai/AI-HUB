import os, json, glob, random

HERE = os.path.dirname(__file__)
TAG_DIR = os.path.join(HERE, "tags")

def _list_json_choices():
    os.makedirs(TAG_DIR, exist_ok=True)
    files = glob.glob(os.path.join(TAG_DIR, "*.json"))
    files = [os.path.basename(p) for p in files]
    files = [f for f in files if f.lower() != "_manifest.json"]
    files.sort(key=lambda s: s.lower())  # works with 01_, 02_ naming
    if not files:
        files = ["(no json files found in tags/)"]
    return files

def _load_tags(filename):
    path = os.path.join(TAG_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    tags = data.get("tags", data if isinstance(data, list) else [])
    if not isinstance(tags, list):
        raise ValueError(f"Expected list under 'tags' in {path}")

    out = []
    for t in tags:
        if t is None:
            continue
        s = str(t).strip()
        if s:
            out.append(s)
    return out

class PersonalTagFilePicker:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "file": (_list_json_choices(),),
                "seed": ("INT", {"default": -1, "min": -1, "max": 2**31 - 1}),
                "pick": ("INT", {"default": 1, "min": 0, "max": 50}),
                "separator": ("STRING", {"default": ", "}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("tags",)
    FUNCTION = "run"
    CATEGORY = "personal"

    def run(self, file, seed, pick, separator):
        if file.startswith("("):
            return ("",)

        tags = _load_tags(file)
        if pick <= 0 or not tags:
            return ("",)

        rng = random.Random(None if seed == -1 else int(seed))
        k = min(int(pick), len(tags))
        chosen = rng.sample(tags, k)
        return (separator.join(chosen),)