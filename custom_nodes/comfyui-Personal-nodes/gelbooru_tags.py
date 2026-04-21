import re
import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests


# Simple in-process cache: tag -> type (int)
_TAG_TYPE_CACHE = {}
_CACHE_LOCK = threading.Lock()


class GelbooruTagsNoArtist:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "post_url": ("STRING", {"default": "https://gelbooru.com/index.php?page=post&s=view&id=12815938"}),
                "mode": (["fast_remove_list", "auto_detect_artist"], {"default": "auto_detect_artist"}),
                "remove_tags": ("STRING", {"default": "sakanaya_(sakanaya952)"}),  # space-separated
                "output_format": (["space", "comma"], {"default": "space"}),
                "max_workers": ("INT", {"default": 12, "min": 1, "max": 32}),
            },
            "optional": {
                "api_user_id": ("STRING", {"default": ""}),
                "api_key": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("tags_without_artist", "artist_tags", "debug_post_fields")
    FUNCTION = "run"
    CATEGORY = "Gelbooru"

    def _extract_post_id(self, url_or_id: str) -> int:
        s = (url_or_id or "").strip()
        if s.isdigit():
            return int(s)
        m = re.search(r"[?&]id=(\d+)", s)
        if not m:
            raise ValueError("Provide a Gelbooru post URL containing ?id=... or a numeric id.")
        return int(m.group(1))

    def _get_json(self, params, api_user_id="", api_key="", timeout=30):
        if api_user_id and api_key:
            params = {**params, "user_id": api_user_id, "api_key": api_key}
        r = requests.get(
            "https://gelbooru.com/index.php",
            params=params,
            headers={"User-Agent": "ComfyUI-GelbooruTags/1.2"},
            timeout=timeout,
        )
        r.raise_for_status()
        return r.json()

    def _split_tags(self, s):
        return [t for t in (s or "").split() if t.strip()]

    def _tag_type(self, session, tag, api_user_id="", api_key=""):
        # Cache first
        with _CACHE_LOCK:
            if tag in _TAG_TYPE_CACHE:
                return _TAG_TYPE_CACHE[tag]

        params = {
            "page": "dapi",
            "s": "tag",
            "q": "index",
            "json": 1,
            "name": tag,
        }
        if api_user_id and api_key:
            params["user_id"] = api_user_id
            params["api_key"] = api_key

        r = session.get(
            "https://gelbooru.com/index.php",
            params=params,
            headers={"User-Agent": "ComfyUI-GelbooruTags/1.2"},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()

        t = None
        # Gelbooru usually returns {"tag":[{"type":...}]} for known tags
        try:
            if isinstance(data, dict) and "tag" in data and data["tag"]:
                obj = data["tag"][0] if isinstance(data["tag"], list) else data["tag"]
                t = obj.get("type", None)
        except Exception:
            t = None

        # Normalize: unknown => None
        with _CACHE_LOCK:
            _TAG_TYPE_CACHE[tag] = t
        return t

    def run(self, post_url, mode, remove_tags, output_format, max_workers, api_user_id="", api_key=""):
        post_id = self._extract_post_id(post_url)

        post_data = self._get_json({
            "page": "dapi",
            "s": "post",
            "q": "index",
            "json": 1,
            "id": post_id
        }, api_user_id, api_key)

        post = None
        if isinstance(post_data, dict) and "post" in post_data:
            if isinstance(post_data["post"], list) and post_data["post"]:
                post = post_data["post"][0]
            elif isinstance(post_data["post"], dict):
                post = post_data["post"]
        if not post:
            raise RuntimeError(f"Could not load post {post_id}")

        all_tags = self._split_tags(post.get("tags"))

        artist_tags = []
        if mode == "fast_remove_list":
            remove_set = set(self._split_tags(remove_tags))
            artist_tags = [t for t in all_tags if t in remove_set]
        else:
            # auto_detect_artist: type==1 is artist on Gelbooru
            with requests.Session() as session:
                futures = {}
                with ThreadPoolExecutor(max_workers=max_workers) as ex:
                    for t in all_tags:
                        futures[ex.submit(self._tag_type, session, t, api_user_id, api_key)] = t
                    for fut in as_completed(futures):
                        tname = futures[fut]
                        ttype = fut.result()
                        if ttype == 1:
                            artist_tags.append(tname)

            # keep stable order as in original tag list
            aset = set(artist_tags)
            artist_tags = [t for t in all_tags if t in aset]

        artist_set = set(artist_tags)
        non_artist = [t for t in all_tags if t not in artist_set]

        if output_format == "comma":
            tags_out = ", ".join(non_artist)
            artist_out = ", ".join(artist_tags)
        else:
            tags_out = " ".join(non_artist)
            artist_out = " ".join(artist_tags)

        dbg = {
            "id": post.get("id"),
            "mode": mode,
            "max_workers": max_workers,
            "has_artist_field": ("artist" in post),
            "artist_field_value": post.get("artist"),
            "detected_artist_tags": artist_tags,
            "removed_tags_input": self._split_tags(remove_tags),
            "tags": post.get("tags"),
        }
        debug_text = json.dumps(dbg, indent=2, ensure_ascii=False)

        return (tags_out, artist_out, debug_text)


NODE_CLASS_MAPPINGS = {"GelbooruTagsNoArtist": GelbooruTagsNoArtist}
NODE_DISPLAY_NAME_MAPPINGS = {"GelbooruTagsNoArtist": "Gelbooru Tags (No Artist + Debug)"}